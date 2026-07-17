'use strict';
/**
 * extractionPipeline — adaptive, self-verifying structured extraction.
 * ─────────────────────────────────────────────────────────────────────────────
 * One receipt ≠ one fixed path. Per image the pipeline:
 *
 *   1. PROBES quality (imageQuality.assess) and plans the run: clean receipts
 *      get a single clean-room model call (no Tesseract text in the prompt —
 *      that's what used to poison clean tabular receipts with ID-numbers-as-
 *      prices); poor images get enhancement and reference-OCR grounding.
 *   2. EXTRACTS strict JSON with the vision model.
 *   3. VERIFIES deterministically (receiptVerify): amount-in-words vs digits,
 *      currency from the printed unit, line arithmetic, identifiers≠money.
 *   4. On failure, REPAIRS: re-asks the model with the exact failed checks as
 *      feedback, optionally zooming into the amount region (Tesseract word
 *      boxes + ImageMagick crop) for a focused re-read of the digits.
 *   5. Applies the deterministic fixes that remain (words win, IDs evicted,
 *      unit-derived currency), nulls what can't be trusted, and returns the
 *      checks + confidence + warnings alongside the data.
 *
 * All model/tool access is injected (createPipeline(deps)) so the whole
 * accuracy loop is unit-testable with a fake visionCall — no LLM required.
 */
const P = require('./persianNumbers');
const V = require('./receiptVerify');

// ── Config (env → defaults). Everything optional & overridable per-instance. ──
function envConfig() {
  const b = (v, dflt) => (v === undefined ? dflt : !/^(0|false|no|off)$/i.test(String(v)));
  return {
    verify: b(process.env.OCR_VERIFY, true),                       // run checks + repair loop
    adaptive: b(process.env.OCR_ADAPTIVE, true),                   // quality probe drives the plan
    fixRounds: Math.max(0, Math.min(4, Number(process.env.OCR_FIX_ROUNDS ?? 2))),
    refMode: ['always', 'never', 'auto'].includes(process.env.OCR_REF_MODE) ? process.env.OCR_REF_MODE : 'auto',
    cropRetry: b(process.env.OCR_CROP_RETRY, true),                // zoomed amount re-read on mismatch
    enhanceForLlm: b(process.env.OCR_ENHANCE_FOR_LLM, true),       // enhanced image to the LLM when poor
  };
}

// Focused prompt for the zoomed amount-region re-read.
const AMOUNT_PROMPT = [
  'This image is a ZOOMED CROP of a Persian (Farsi) receipt, around the amount area.',
  'Read ONLY the monetary amount(s) printed here. Return ONE strict minified JSON object, nothing else:',
  '{"digits": string|null, "unit": "ریال"|"تومان"|null, "words": string|null}',
  '- "digits": the full printed amount with EVERY digit (keep separators, e.g. "۱۲٬۰۰۰٬۰۰۰"). Count the digits carefully; never add or drop a zero.',
  '- "unit": the currency word printed right next to the amount, exactly ریال or تومان.',
  '- "words": the amount-in-words phrase («به حروف …») if visible, verbatim.',
  'Ignore cheque/account/reference/terminal/card numbers and dates — they are not amounts.',
].join('\n');

/** Build the repair instruction: base prompt + the precise failed checks. */
function repairInstruction(basePrompt, issues, hints) {
  const parts = [
    basePrompt,
    '',
    '--- VERIFICATION FAILED — FIX THESE EXACT PROBLEMS ---',
    'Your previous JSON for this same image failed these deterministic checks. Re-read the image and return the corrected FULL JSON (same shape). Do not repeat the same mistake:',
    ...issues.map((s, i) => `${i + 1}. ${s}`),
  ];
  if (hints && hints.length) {
    parts.push('', '--- ADDITIONAL EVIDENCE (from a zoomed re-read of the amount region) ---', ...hints);
  }
  return parts.join('\n');
}

/** Median of an array (word heights) — robust against a few giant boxes. */
function median(xs) {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function createPipeline(deps) {
  const {
    visionCall,        // async ({instruction,image,note,temperature,maxTokens}) → string
    structurePrompt,   // the base extraction prompt
    withReference,     // (instruction, refText) → instruction with grounding block
    parseJsonLoose,    // tolerant JSON parse
    referenceOcr,      // async (image) → Tesseract text or ''
    textOcr,           // { available(), ocrWords(buffer,mime) }
    quality,           // imageQuality: { assess, enhance, cropBand, status }
    config,            // optional overrides of envConfig()
  } = deps;
  const cfg = Object.assign(envConfig(), config || {});

  /** Locate the amount region via Tesseract word boxes → cropped zoom, or null. */
  async function amountCrop(buffer, mime, probe) {
    if (!cfg.cropRetry || !textOcr || !textOcr.available() || !quality) return null;
    try {
      const words = await textOcr.ocrWords(buffer, mime);
      if (!words.length) return null;
      const keys = words.filter((w) => /(مبلغ|جمع|حروف|پرداخت|ریال|تومان)/.test(P.normalizeDigits(w.text)));
      if (!keys.length) return null;
      const h = median(words.map((w) => w.height)) || 20;
      let top = Math.min(...keys.map((w) => w.top)) - 2 * h;
      let bottom = Math.max(...keys.map((w) => w.top + w.height)) + 2 * h;
      const imgH = probe.height || Math.max(...words.map((w) => w.top + w.height));
      const imgW = probe.width || Math.max(...words.map((w) => w.left + w.width));
      // A band that swallows most of the receipt is no zoom at all.
      if (bottom - top > imgH * 0.6) return null;
      return quality.cropBand(buffer, mime, { top, bottom, width: imgW, height: imgH });
    } catch { return null; }
  }

  /** Zoomed re-read of the amount region → evidence hints for the repair round. */
  async function reReadAmount(buffer, mime, note, probe) {
    const crop = await amountCrop(buffer, mime, probe);
    if (!crop) return [];
    try {
      const raw = await visionCall({ instruction: AMOUNT_PROMPT, image: crop, note, temperature: 0, maxTokens: 300 });
      const j = parseJsonLoose(raw);
      if (!j) return [];
      const hints = [];
      const val = P.parseAmount(j.digits);
      if (val != null) hints.push(`The zoomed amount region reads: ${j.digits} (= ${val}).`);
      if (j.unit) hints.push(`The unit printed next to it is «${j.unit}».`);
      if (j.words) {
        const wv = P.wordsToNumber(j.words);
        hints.push(`The amount in words there is «${j.words}»${wv != null ? ` (= ${wv})` : ''}.`);
      }
      return hints;
    } catch { return []; }
  }

  /** One structured model call → coerced object (or null) + raw string. */
  async function callModel(instruction, image, note) {
    const raw = await visionCall({ instruction, image, note, temperature: 0 });
    const parsed = parseJsonLoose(raw);
    return { data: parsed ? V.coerceStructured(parsed) : null, raw };
  }

  /**
   * extract(image, { note, transcription, onStatus })
   * → { data, raw, verification } ; `data` is null only when the model never
   * returned valid JSON. `verification` = { quality, passes, checks, confidence,
   * warnings, corrected } and is also embedded in data.verification.
   */
  async function extract(image, { note = '', transcription = '', onStatus } = {}) {
    const status = (s) => { try { if (onStatus) onStatus(s); } catch { /* ignore */ } };
    const buffer = image && image.buffer ? Buffer.from(image.buffer) : null;
    const mime = (image && image.mime) || 'image/jpeg';

    // 1) probe quality and plan the run
    status({ phase: 'assess' });
    const probe = cfg.adaptive && quality && buffer ? await quality.assess(buffer, mime) : { quality: 'unknown', reasons: [] };
    const poor = probe.quality === 'poor';
    const refInPrompt = cfg.refMode === 'always' || (cfg.refMode === 'auto' && poor);

    // reference OCR: gathered for the VERIFIER whenever Tesseract exists, but fed
    // to the model's prompt only per plan (clean receipts stay clean-room).
    const refText = referenceOcr ? await referenceOcr(image) : '';

    // poor images additionally go to the model enhanced (upscaled/normalised)
    let modelImage = image;
    if (poor && cfg.enhanceForLlm && quality && buffer) {
      const enhanced = await quality.enhance(buffer, mime);
      if (enhanced) modelImage = enhanced;
    }

    const baseInstruction = refInPrompt ? withReference(structurePrompt, refText) : structurePrompt;

    // 2) first extraction
    status({ phase: 'extract', quality: probe.quality });
    let { data, raw } = await callModel(baseInstruction, modelImage, note);
    let passes = 1;

    if (!cfg.verify) {
      return { data, raw, verification: { quality: probe.quality, passes, checks: null, confidence: null, warnings: [], corrected: false } };
    }

    const ctx = { transcription, refText };
    let v = data ? V.verify(data, ctx) : null;

    // 3) repair rounds with targeted feedback (+ zoomed amount evidence once)
    let hints = null;
    for (let round = 1; round <= cfg.fixRounds && (!data || !V.passed(v)); round++) {
      status({ phase: 'repair', round, of: cfg.fixRounds });
      if (hints === null && data && v.issues.some((i) => /total|amount|zero|مبلغ/i.test(i)) && buffer) {
        hints = await reReadAmount(buffer, mime, note, probe);
      }
      const issues = data ? v.issues : ['Your previous response was not valid JSON. Return exactly one strict minified JSON object of the required shape.'];
      const attempt = await callModel(repairInstruction(baseInstruction, issues, hints), modelImage, note);
      passes++;
      if (attempt.data) { data = attempt.data; raw = attempt.raw; v = V.verify(data, ctx); }
    }

    if (!data) {
      return { data: null, raw, verification: { quality: probe.quality, passes, checks: null, confidence: 0, warnings: ['model never returned valid JSON'], corrected: false } };
    }

    // 4) deterministic fixes for whatever the model kept getting wrong
    status({ phase: 'finalize' });
    const fixed = V.applyFixes(data, v);
    const finalChecks = V.verify(fixed.data, ctx).checks;
    const verification = {
      quality: probe.quality,
      qualityReasons: probe.reasons || [],
      passes,
      checks: finalChecks,
      confidence: V.confidence(finalChecks, fixed.warnings.length),
      warnings: fixed.warnings,
      corrected: fixed.changed,
    };
    fixed.data.verification = verification;
    return { data: fixed.data, raw, verification };
  }

  return { extract, config: cfg };
}

module.exports = { createPipeline, envConfig, repairInstruction, AMOUNT_PROMPT };

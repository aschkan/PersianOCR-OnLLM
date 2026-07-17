/**
 * ocrService — vision-LLM client for Persian receipt OCR.
 * [same HTTP philosophy & shape as the sibling platforms' aiService]
 *
 * The receipt image is sent to an OpenAI-compatible /chat/completions endpoint
 * (LM Studio on the LAN) as a MULTIMODAL user message: a text instruction plus
 * the image as a base64 `image_url`. A vision model such as gemma-3-4b-it reads
 * the pixels directly and returns the transcription — no separate OCR engine.
 *
 * Two tasks are exposed:
 *   transcribe()       → faithful Markdown transcription of everything on the
 *                        receipt (text, tables, handwriting), streaming-capable.
 *   extractStructured()→ turns the same image into a strict JSON invoice object.
 *
 * Config comes from .env with built-in defaults; LM Studio lives on a SEPARATE
 * Windows box, so OCR_AI_URL points across the network (not localhost).
 */
const http = require('http');
const https = require('https');
const textOcr = require('./textOcr');   // optional Tesseract grounding (digits)

// ── Config (env → built-in defaults) ──────────────────────────────────────────
const AI_URL      = (process.env.OCR_AI_URL || 'http://localhost:1234/v1').replace(/\/$/, '');
const AI_MODEL    = process.env.OCR_AI_MODEL || 'gemma-3-4b-it';
const AI_KEY      = process.env.OCR_AI_KEY || '';
const TIMEOUT_MS  = Number(process.env.OCR_TIMEOUT_MS) || 180000;
const MAX_TOKENS  = Number(process.env.OCR_MAX_TOKENS) || 4096;
const TEMPERATURE = process.env.OCR_TEMPERATURE !== undefined ? Number(process.env.OCR_TEMPERATURE) : 0.1;

// How to encode the image in `image_url.url`. Different LM Studio / llama.cpp
// builds disagree: some want a full data-URL, others reject it and demand the
// RAW base64 ("'url' field must be a base64 encoded image."). 'auto' tries the
// worked. It just works — no env needed. OCR_IMAGE_MODE only sets which format
// to TRY FIRST (still falls back to the others), so a wrong value can't break it.
//
// Different OpenAI-compatible / LM Studio / llama.cpp builds accept the image in
// different shapes. We try each until one is accepted, then cache the winner.
const IMAGE_FORMATS = [
  // Standard OpenAI: image_url is an object with a data-URL.
  { id: 'dataurl',        build: (b64, mime) => ({ url: `data:${mime};base64,${b64}` }) },
  // Some builds want the RAW base64 in url ("'url' field must be a base64…").
  { id: 'base64',         build: (b64)       => ({ url: b64 }) },
  // Some accept image_url as a plain string data-URL (not an object).
  { id: 'dataurl-string', build: (b64, mime) => `data:${mime};base64,${b64}` },
  // …or a plain raw-base64 string.
  { id: 'base64-string',  build: (b64)       => b64 },
];
// Preferred-first order from the env hint (optional); cached winner wins after.
let _fmtId = IMAGE_FORMATS.some((f) => f.id === process.env.OCR_IMAGE_MODE) ? process.env.OCR_IMAGE_MODE : null;

function orderedFormats() {
  if (!_fmtId) return IMAGE_FORMATS;
  const first = IMAGE_FORMATS.filter((f) => f.id === _fmtId);
  const rest = IMAGE_FORMATS.filter((f) => f.id !== _fmtId);
  return first.concat(rest);
}

// Multi-pass "self-consistency" OCR. Small models (e.g. gemma-3-4b) misread the
// odd digit or drop a trailing zero. Running the transcription a few times with a
// little temperature and then reconciling the attempts against the image catches
// most of those. 1 = off (single pass, current behaviour).
const OCR_PASSES = Math.max(1, Math.min(6, Number(process.env.OCR_PASSES) || 1));
const OCR_DRAFT_TEMP = process.env.OCR_DRAFT_TEMP !== undefined ? Number(process.env.OCR_DRAFT_TEMP) : 0.35;

function getConfig() {
  return { url: AI_URL, model: AI_MODEL, hasKey: !!AI_KEY, timeoutMs: TIMEOUT_MS, maxTokens: MAX_TOKENS, temperature: TEMPERATURE, imageMode: _fmtId || 'auto', passes: OCR_PASSES, tesseract: textOcr.status() };
}

// Run the reference OCR engine (Tesseract) on the image; '' if unavailable.
async function referenceOcr(image) {
  if (!textOcr.available()) return '';
  try {
    let buf, mime;
    if (image && image.buffer) { buf = Buffer.from(image.buffer); mime = image.mime; }
    else { const t = toImage(image); buf = Buffer.from(t.b64, 'base64'); mime = t.mime; }
    return await textOcr.ocrText(buf, mime);
  } catch { return ''; }
}

// Append the reference-OCR text to a prompt so the model copies digits correctly.
function withReference(instruction, ref) {
  if (!ref) return instruction;
  return instruction +
    '\n\n--- REFERENCE OCR (advisory only) ---\n' +
    'A traditional OCR engine read the text below from the SAME image. Use it ONLY to double-check your own reading of long amounts (e.g. confirm you did not drop a zero on the total). The IMAGE is the ground truth. Do NOT blindly copy these numbers: the engine cannot tell an amount from a cheque/account/reference/card number, so decide each number\'s ROLE from the image and the labels, not from this text. When it conflicts with the amount-in-words on the receipt, the words win.\n' +
    ref +
    '\n--- END REFERENCE OCR ---';
}

// Normalize whatever the caller passed (a {buffer,mime} or a data-URL string)
// into { b64, mime }.
function toImage(image) {
  if (image && image.buffer) return { b64: Buffer.from(image.buffer).toString('base64'), mime: image.mime || 'image/jpeg' };
  const s = String(image || '');
  const m = s.match(/^data:([^;]+);base64,([\s\S]*)$/);
  if (m) return { b64: m[2], mime: m[1] };
  return { b64: s.replace(/^data:[^,]*,/, ''), mime: 'image/jpeg' }; // assume already base64
}

// Any error where trying a DIFFERENT image format could help: the image-format
// complaints, plus any 4xx (the server rejected the request shape). 5xx / timeout
// / network errors are NOT format problems, so we don't cycle formats on those.
function shouldTryNextFormat(msg) {
  const s = String(msg || '');
  return /HTTP 4\d\d/.test(s) || isImageFormatError(s);
}

// A 400 that means "you encoded the image wrong".
function isImageFormatError(msg) {
  return /base64 encoded image|must be a base64|'url' field|image[_ ]?url/i.test(String(msg || ''));
}

// ── Prompts ───────────────────────────────────────────────────────────────────
// Faithful transcription. Written to make a small model behave like a careful
// OCR engine rather than a chatbot: transcribe, don't translate or summarise.
const TRANSCRIBE_PROMPT = [
  'You are a professional OCR engine specialised in Persian (Farsi) documents and receipts.',
  'Transcribe EVERYTHING visible in this image, exactly as it appears — printed or handwritten.',
  '',
  'Rules:',
  '- Output the transcription only. No preamble, no explanation, no summary, no code fences.',
  '- Do NOT translate. Keep Persian text in Persian and keep the original digits (Persian ۰-۹ or English) exactly as written.',
  '- Preserve the reading order and line breaks of the document (Persian reads right-to-left).',
  '- Do NOT build Markdown or ASCII tables. For rows of items/prices, put each row on its own line with its values separated by " — " (e.g. "شیر — ۲ — ۴۸٬۰۰۰"). Keep it as clean readable lines; the structured extractor builds the real table.',
  '- NUMBERS ARE CRITICAL. Persian prices (ریال/تومان) are usually large — thousands or millions. Read every digit carefully and copy the FULL number; never drop OR add trailing zeros (keep ۱٬۲۰۰٬۰۰۰ exactly). Keep the thousands separators exactly as printed.',
  '- If the receipt also writes an amount in words («به حروف …»), transcribe it verbatim — it is the reliable check for the numeric amount.',
  '- Keep the currency unit exactly as printed (ریال vs تومان) — they are different (1 تومان = 10 ریال). Do not convert.',
  '- Keep every number, unit (ریال/تومان), date, phone number and code faithful — do not round, reformat or invent values.',
  '- For unclear or illegible handwriting, transcribe your best guess and mark it with «؟» right after the uncertain part.',
  '- If part of the image is empty or not text, simply skip it.',
].join('\n');

// Reconciliation / proof-reading pass. Given several independent OCR attempts of
// the same image, produce one corrected transcription — this is where dropped
// zeros and misread digits get caught by cross-checking the attempts vs. pixels.
const RECONCILE_PROMPT = [
  'You are a meticulous proof-reader for Persian (Farsi) receipt OCR.',
  'Below are several INDEPENDENT OCR attempts at the SAME receipt (the image is attached too).',
  'Produce ONE final, corrected transcription that is more accurate than any single attempt.',
  '',
  'Rules:',
  '- Cross-check the attempts against the image. Where they disagree, pick the reading the image supports.',
  '- NUMBERS ARE THE PRIORITY. Persian prices (ریال/تومان) are large — thousands/millions. Verify EVERY digit against the image and keep the COMPLETE number; never drop trailing zeros (keep ۱٬۲۰۰٬۰۰۰, not ۱۲۰۰). If one attempt has more zeros than another and the image agrees, keep the longer one. Preserve thousands separators.',
  '- Keep the original digits (Persian ۰-۹ or English) and Persian text exactly; do not translate, round, or summarise.',
  '- Render tables as GitHub-flavoured Markdown with the original headers.',
  '- Output only the final transcription — no commentary, no notes, no code fences.',
].join('\n');

// Structured extraction → strict JSON. Kept separate so each call is one focused
// task, which a 4B model handles far more reliably than a combined mega-prompt.
const STRUCTURE_PROMPT = [
  'You are a forensic accountant extracting structured data from a Persian (Farsi) receipt / invoice / cheque-payment-order image.',
  'Return ONE strict, minified JSON object and nothing else — no markdown, no comments, no code fences.',
  '',
  'ACCURACY RULES — follow them exactly, they prevent the most common mistakes:',
  '1) AMOUNT IN WORDS IS THE SOURCE OF TRUTH. Persian receipts usually write the amount twice: in digits («به عدد» / «مبلغ») and in words («به حروف …»). Find the words (e.g. «دوازده میلیون ریال») and convert them to a number (دوازده میلیون = 12,000,000; یک میلیارد = 1,000,000,000). If the digits you read disagree with the words, TRUST THE WORDS and set the total to the words value. This is how you avoid adding or dropping a zero.',
  '2) CURRENCY comes ONLY from the unit printed next to the amount: «ریال» → "IRR", «تومان» → "IRT". Never convert or assume. If it says ریال, it is IRR even if the number looks big.',
  '3) IDENTIFIERS ARE NOT MONEY. Cheque numbers (شماره چک), account numbers (شماره حساب), reference/tracking numbers (مرجع/پیگیری), terminal (ترمینال), card and phone numbers, and dates must NEVER be placed in unitPrice/total/subtotal. A number is money ONLY if it is in a مبلغ/ریال/تومان column. Long ID-like numbers (e.g. 987650, 9988766, 123456) are not prices.',
  '4) Do the arithmetic as a check: qty × unitPrice = total per line; the money-column values should sum to the total; and the total must equal the amount-in-words. Fix any field that fails.',
  '5) Never invent or pad digits. Copy amounts exactly; use null when unsure.',
  '',
  'Return this exact shape; use null (or [] for items) when a field is absent. Persian digits → English digits in NUMERIC fields only:',
  '{',
  '  "merchant": string|null,        // shop / business name',
  '  "branch": string|null,',
  '  "address": string|null,',
  '  "phone": string|null,',
  '  "invoiceNumber": string|null,   // the document/serial number, NOT the date',
  '  "date": string|null,            // keep as printed (e.g. Jalali 1403/02/15)',
  '  "time": string|null,',
  '  "amountInWords": string|null,   // the exact «به حروف …» text if present',
  '  "items": [ { "name": string, "qty": number|null, "unitPrice": number|null, "total": number|null } ],',
  '  "subtotal": number|null,',
  '  "discount": number|null,',
  '  "tax": number|null,',
  '  "total": number|null,           // MUST equal amountInWords when that is present',
  '  "currency": string|null,        // "IRR" (ریال) or "IRT" (تومان) — from the printed unit',
  '  "paymentMethod": string|null',
  '}',
].join('\n');

// ── Low-level HTTP (mirrors aiService: raw core modules, no fetch dep) ─────────
function pickLib(u) { return u.protocol === 'http:' ? http : https; }

/** Non-streaming POST → resolves { status, body }. */
function post(url, headers, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = pickLib(u).request(
      { hostname: u.hostname, port: u.port || (u.protocol === 'http:' ? 80 : 443), path: u.pathname + u.search, method: 'POST', headers, timeout: timeoutMs },
      (res) => { const c = []; res.on('data', (d) => c.push(d)); res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(c).toString() })); }
    );
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('vision model timeout')); });
    req.write(body); req.end();
  });
}

/** Streaming POST (SSE). Emits each token via onChunk(text); resolves with the
 *  full concatenated text once the stream ends. */
function postStream(url, headers, body, onChunk, timeoutMs) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    let full = '';
    const req = pickLib(u).request(
      { hostname: u.hostname, port: u.port || (u.protocol === 'http:' ? 80 : 443), path: u.pathname + u.search, method: 'POST', headers, timeout: timeoutMs },
      (res) => {
        if (res.statusCode !== 200) {
          const c = []; res.on('data', (d) => c.push(d));
          res.on('end', () => reject(new Error(`vision model HTTP ${res.statusCode}: ${Buffer.concat(c).toString().slice(0, 200)}`)));
          return;
        }
        res.setEncoding('utf8');
        let buf = '';
        res.on('data', (chunk) => {
          buf += chunk;
          let idx;
          while ((idx = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, idx).trim();
            buf = buf.slice(idx + 1);
            if (!line.startsWith('data:')) continue;
            const data = line.slice(5).trim();
            if (data === '[DONE]') continue;
            try {
              const tok = JSON.parse(data)?.choices?.[0]?.delta?.content || '';
              if (tok) { full += tok; onChunk(tok); }
            } catch { /* keep-alive / partial line */ }
          }
        });
        res.on('end', () => resolve(full));
      }
    );
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('vision model timeout')); });
    req.write(body); req.end();
  });
}

function headers(len) {
  const h = { 'Content-Type': 'application/json', 'Content-Length': len };
  if (AI_KEY) h['Authorization'] = `Bearer ${AI_KEY}`;
  return h;
}

/** Build the multimodal message array (text instruction + image_url value). */
function visionMessages(instruction, imageUrlValue, userNote) {
  const content = [{ type: 'text', text: userNote ? `${instruction}\n\nExtra context from the user: ${userNote}` : instruction }];
  content.push({ type: 'image_url', image_url: imageUrlValue });
  return [{ role: 'user', content }];
}

/**
 * Core vision call that AUTO-NEGOTIATES the image format. It tries each known
 * request shape (data-URL object, raw-base64 object, string variants) until the
 * server accepts one, then caches the winner so later calls use it directly. It
 * only advances to the next format on a format-ish error (4xx / "must be base64…")
 * and never mid-stream (once a token has been emitted). Net effect: it works with
 * whatever LM Studio / llama.cpp build you point it at — no env needed.
 *   opts: { instruction, image:{buffer,mime}|dataUrl, note, temperature, maxTokens, onChunk }
 */
async function visionCall({ instruction, image, note = '', temperature = TEMPERATURE, maxTokens = MAX_TOKENS, onChunk }) {
  const { b64, mime } = toImage(image);
  const stream = typeof onChunk === 'function';
  const url = `${AI_URL}/chat/completions`;
  const formats = orderedFormats();

  let lastErr;
  for (let i = 0; i < formats.length; i++) {
    const fmt = formats[i];
    const messages = visionMessages(instruction, fmt.build(b64, mime), note);
    const payload = JSON.stringify({ model: AI_MODEL, messages, max_tokens: maxTokens, temperature, stream });
    let emitted = false;
    const guard = (t) => { emitted = true; onChunk(t); };
    try {
      let out;
      if (stream) {
        const h = headers(Buffer.byteLength(payload)); h['Accept'] = 'text/event-stream';
        out = await postStream(url, h, payload, guard, TIMEOUT_MS);
      } else {
        const { status, body } = await post(url, headers(Buffer.byteLength(payload)), payload, TIMEOUT_MS);
        if (status !== 200) throw new Error(`vision model HTTP ${status}: ${body.slice(0, 200)}`);
        out = JSON.parse(body)?.choices?.[0]?.message?.content?.trim() || '';
      }
      _fmtId = fmt.id; // remember the format the server accepted
      return out;
    } catch (e) {
      lastErr = e;
      // Can't restart once tokens were streamed; and only re-try for a
      // format-ish error when another format remains.
      if (emitted || !shouldTryNextFormat(e.message) || i >= formats.length - 1) throw e;
    }
  }
  throw lastErr;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Transcribe a receipt image to faithful Markdown.
 *   transcribe(image, { note, onChunk })   image = {buffer,mime} or a data-URL
 * If onChunk is provided the response is streamed and the full text is returned
 * when done; otherwise a single blocking call is made.
 */
async function transcribe(image, { note = '', onChunk, ref } = {}) {
  if (ref === undefined) ref = await referenceOcr(image);
  return visionCall({ instruction: withReference(TRANSCRIBE_PROMPT, ref), image, note, onChunk });
}

/**
 * Higher-accuracy transcription: run several independent passes, then reconcile
 * them against the image in a final proof-reading pass (streamed if onChunk).
 * `passes` defaults to OCR_PASSES; 1 falls straight through to transcribe().
 * This is where dropped trailing zeros / misread digits get corrected.
 *   transcribeRefined(image, { note, passes, onChunk, onStatus })
 */
async function transcribeRefined(image, { note = '', passes = OCR_PASSES, onChunk, onStatus } = {}) {
  passes = Math.max(1, Math.min(6, Number(passes) || 1));
  // Reference OCR once, reused across every pass (grounds digits everywhere).
  const ref = await referenceOcr(image);
  if (passes <= 1) return transcribe(image, { note, onChunk, ref });

  const draftInstruction = withReference(TRANSCRIBE_PROMPT, ref);
  // 1) draft passes (non-streaming, a little temperature for useful diversity).
  const drafts = [];
  for (let i = 0; i < passes; i++) {
    if (onStatus) onStatus({ phase: 'draft', pass: i + 1, of: passes });
    try {
      const d = await visionCall({ instruction: draftInstruction, image, note, temperature: OCR_DRAFT_TEMP });
      if (d && d.trim()) drafts.push(d.trim());
    } catch (e) { /* a single failed pass shouldn't sink the batch */ }
  }
  if (!drafts.length) throw new Error('all OCR passes failed');
  if (drafts.length === 1) { if (onChunk) onChunk(drafts[0]); return drafts[0]; }

  // 2) reconciliation pass — image + reference OCR + all drafts, deterministic.
  if (onStatus) onStatus({ phase: 'reconcile', of: passes });
  const attempts = drafts.map((d, i) => `### Attempt ${i + 1}\n${d}`).join('\n\n');
  const instruction = withReference(`${RECONCILE_PROMPT}\n\n--- OCR ATTEMPTS ---\n${attempts}`, ref);
  return visionCall({ instruction, image, note, temperature: 0, onChunk });
}

/**
 * Extract a structured JSON invoice object from a receipt image.
 * Returns { data, raw } — `data` is the parsed object (or null if the model
 * didn't return valid JSON), `raw` is the model's raw string for debugging.
 */
async function extractStructured(image, { note = '' } = {}) {
  const ref = await referenceOcr(image);
  const raw = await visionCall({ instruction: withReference(STRUCTURE_PROMPT, ref), image, note, temperature: 0 });
  return { data: parseJsonLoose(raw), raw };
}

/** Tolerant JSON parse: strips code fences and grabs the outermost {...}. */
function parseJsonLoose(s) {
  if (!s) return null;
  let t = String(s).trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start >= 0 && end > start) t = t.slice(start, end + 1);
  try { return JSON.parse(t); } catch { return null; }
}

/** Ping the vision backend so the UI can show reachability. Never throws. */
async function testConnection() {
  const t0 = Date.now();
  const payload = JSON.stringify({ model: AI_MODEL, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1, stream: false });
  try {
    const { status } = await post(`${AI_URL}/chat/completions`, headers(Buffer.byteLength(payload)), payload, 15000);
    if (status !== 200) return { ok: false, error: `HTTP ${status}`, url: AI_URL, model: AI_MODEL };
    return { ok: true, ms: Date.now() - t0, url: AI_URL, model: AI_MODEL };
  } catch (e) {
    return { ok: false, error: String(e.message || e), url: AI_URL, model: AI_MODEL };
  }
}

module.exports = { transcribe, transcribeRefined, extractStructured, testConnection, getConfig };

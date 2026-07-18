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
const imageQuality = require('./imageQuality');           // per-image quality probe + enhance/crop
const P = require('./persianNumbers');                    // digit-run guard for the dictation fix
const { createPipeline } = require('./extractionPipeline'); // adaptive self-verifying extraction

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
// Preferred-first order from the env hint (optional).
let _fmtId = IMAGE_FORMATS.some((f) => f.id === process.env.OCR_IMAGE_MODE) ? process.env.OCR_IMAGE_MODE : null;
// The format PROVEN to work against the running vision server (via probe).
// Reset whenever the server starts complaining again (LM Studio restart/upgrade).
let _negotiated = null;

function orderedFormats() {
  const hint = _negotiated || _fmtId;
  if (!hint) return IMAGE_FORMATS;
  const first = IMAGE_FORMATS.filter((f) => f.id === hint);
  const rest = IMAGE_FORMATS.filter((f) => f.id !== hint);
  return first.concat(rest);
}

// 1×1 white PNG used to probe which image encoding the server accepts. The
// probe is a tiny non-streaming request, so negotiation NEVER happens inside a
// real (possibly streaming) OCR call — streams can't be retried once a token
// has been emitted, which is exactly how the old in-band negotiation got stuck.
const PROBE_PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

// Payload guard: images bigger than this (decoded bytes) are downscaled with
// ImageMagick before being sent to the vision server — huge PC screenshots/raw
// scans otherwise blow the server's request/context limits. 0 disables.
const LLM_MAX_MB = process.env.OCR_LLM_MAX_MB !== undefined ? Number(process.env.OCR_LLM_MAX_MB) : 1;
const LLM_MAX_DIM = Number(process.env.OCR_LLM_MAX_DIM) || 2048;

// Multi-pass "self-consistency" OCR. Small models (e.g. gemma-3-4b) misread the
// odd digit or drop a trailing zero. Running the transcription a few times with a
// little temperature and then reconciling the attempts against the image catches
// most of those. 1 = off (single pass, current behaviour).
const OCR_PASSES = Math.max(1, Math.min(6, Number(process.env.OCR_PASSES) || 1));
const OCR_DRAFT_TEMP = process.env.OCR_DRAFT_TEMP !== undefined ? Number(process.env.OCR_DRAFT_TEMP) : 0.35;

// Dictation repair (default ON): after the main transcription, read the image
// a SECOND time independently, then ask the model to fix ONLY the garbled
// Persian words of the main text (numbers/structure untouchable), using the
// second reading + the image as evidence. A deterministic digit-run guard
// rejects the result if any number changed. Costs two extra model calls.
const SPELLFIX = !/^(0|false|no|off)$/i.test(process.env.OCR_SPELLFIX ?? 'true');

function getConfig() {
  return {
    url: AI_URL, model: AI_MODEL, hasKey: !!AI_KEY, timeoutMs: TIMEOUT_MS, maxTokens: MAX_TOKENS,
    temperature: TEMPERATURE, imageMode: _negotiated || _fmtId || 'auto', passes: OCR_PASSES, spellfix: SPELLFIX,
    llmImageGuard: { maxMb: LLM_MAX_MB, maxDim: LLM_MAX_DIM },
    tesseract: textOcr.status(), imageTools: imageQuality.status(), pipeline: pipeline.config,
  };
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

// A complaint about HOW the image was encoded in the request — the only class
// of error where switching to a different image format can help. Covers every
// known LM Studio / llama.cpp wording, including:
//   "Invalid 'content': 'image_url' field must be an object in the form
//    { image_url: { url: \"...base64 encoded image here...\" } }"
//   "'url' field must be a base64 encoded image."
function isImageFormatError(msg) {
  return /must be an object|must be a base64|base64 encoded image|'url' field|image[_ ]?url|invalid '?content'?/i
    .test(String(msg || ''));
}

// The request body itself was too big for the server — switching formats can't
// fix that; the image must be downscaled (or ImageMagick installed).
function isPayloadError(msg) {
  return /HTTP 413|payload too large|request entity too large|body.{0,20}limit|exceeds.{0,30}(limit|maximum|length)|context length|too (large|big|long)/i
    .test(String(msg || ''));
}

// The request never reached (or never came back from) the vision server at all
// — LM Studio down, wrong IP/port, firewall, dead network. Retrying passes or
// switching image formats cannot help; the user needs the REASON and the URL.
function isConnectionError(msg) {
  return /ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|socket hang up|vision (model|server) timeout/i
    .test(String(msg || ''));
}

/** Turn a raw socket error into an actionable message with the target URL. */
function describeConnectionError(msg) {
  const s = String(msg || '');
  let hint;
  if (/ECONNREFUSED/i.test(s)) {
    hint = 'connection refused — nothing is listening there. In LM Studio open the Developer tab and Start Server (enable "Serve on Local Network"), and check OCR_AI_URL host/port';
  } else if (/ENOTFOUND|EAI_AGAIN/i.test(s)) {
    hint = 'the hostname does not resolve — check OCR_AI_URL';
  } else if (/ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|timeout/i.test(s)) {
    hint = 'no response — check the GPU machine is on and reachable (same network, correct IP) and that its firewall allows the LM Studio port';
  } else {
    hint = 'the connection failed before the model could run';
  }
  return `cannot reach the vision server at ${AI_URL}: ${hint} (${s})`;
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

// Dictation repair: fix ONLY the garbled Persian words of the MAIN transcription,
// with a second independent reading as hints and the image as ground truth.
// Numbers and structure are explicitly untouchable (and enforced by a
// deterministic digit-run guard after the call).
function spellfixInstruction(main, second) {
  return [
    'You are a Persian (Farsi) OCR proof-reader. The receipt image is attached — it is the ground truth.',
    'Below is the MAIN transcription of this image. It has the right structure and the right NUMBERS, but some Persian words are misspelled/garbled (e.g. «عبلغ به عحد» should be «مبلغ به عدد», «ترم اقزارهای مختلق» should be «نرم افزارهای مختلف»).',
    'A SECOND independent reading of the same image follows — use it ONLY as a hint for what a garbled word should have been.',
    '',
    'Rewrite the MAIN transcription with ONLY these corrections:',
    '- Fix misspelled or garbled Persian words so they read as printed on the image.',
    '- DO NOT change ANY digit or number: every amount, date, time, code and phone number must stay EXACTLY as in the MAIN text (same digits, same separators).',
    '- DO NOT add anything that is not in the MAIN text. DO NOT drop lines. DO NOT reorder or restructure. Keep the line breaks as they are.',
    '- If you are not sure what a word should be, keep the MAIN text version unchanged.',
    '- Output ONLY the corrected text — no commentary, no code fences.',
    '',
    '--- MAIN TRANSCRIPTION ---',
    main,
    '--- SECOND READING (hints only) ---',
    second,
    '--- END ---',
  ].join('\n');
}

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
  '  "paymentMethod": string|null,',
  '  "identifiers": {                // every labelled NON-money number goes here, never in amounts',
  '    "cheque": string|null, "account": string|null, "reference": string|null,',
  '    "terminal": string|null, "card": string|null, "phone": string|null',
  '  }',
  '}',
  '',
  'Before answering, SELF-CHECK: (a) count the digits of total and compare with the amount-in-words value; (b) confirm the currency is the printed unit; (c) confirm every number you placed in a money field sits in a مبلغ/ریال/تومان column on the image; (d) confirm cheque/account/reference/terminal/card numbers are ONLY inside "identifiers". Fix any failure by re-reading the image before you answer.',
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
        let errMsg = '';   // error carried INSIDE a 200 response (SSE error event
        let raw = '';      // or a plain JSON body) — must not dissolve into ''.
        res.on('data', (chunk) => {
          if (raw.length < 2000) raw += chunk;
          buf += chunk;
          let idx;
          while ((idx = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, idx).trim();
            buf = buf.slice(idx + 1);
            if (!line.startsWith('data:')) continue;
            const data = line.slice(5).trim();
            if (data === '[DONE]') continue;
            try {
              const j = JSON.parse(data);
              if (j?.error) errMsg = typeof j.error === 'string' ? j.error : (j.error.message || JSON.stringify(j.error));
              const tok = j?.choices?.[0]?.delta?.content || '';
              if (tok) { full += tok; onChunk(tok); }
            } catch { /* keep-alive / partial line */ }
          }
        });
        res.on('end', () => {
          if (full) return resolve(full);
          // Nothing was generated. If the body carried an error (SSE error event,
          // or a non-SSE JSON error body some builds send with status 200), fail
          // loudly with it instead of resolving to an empty transcription.
          if (!errMsg && raw.trim()) {
            try { const j = JSON.parse(raw); if (j?.error) errMsg = typeof j.error === 'string' ? j.error : (j.error.message || JSON.stringify(j.error)); } catch { /* not JSON */ }
          }
          if (errMsg) return reject(new Error(`vision model error: ${errMsg}`));
          resolve(full);
        });
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

/** Tiny GET (used by the reachability preflight — LM Studio serves /v1/models). */
function get(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = pickLib(u).request(
      { hostname: u.hostname, port: u.port || (u.protocol === 'http:' ? 80 : 443), path: u.pathname + u.search, method: 'GET', headers: AI_KEY ? { Authorization: `Bearer ${AI_KEY}` } : {}, timeout: timeoutMs },
      (res) => { const c = []; res.on('data', (d) => c.push(d)); res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(c).toString() })); }
    );
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('vision server timeout')); });
    req.end();
  });
}

/**
 * Cheap reachability preflight, run by the controllers BEFORE any OCR work
 * starts: one 4-second GET /models. When the GPU box is off / LM Studio isn't
 * serving / the IP is wrong, the user gets the precise reason immediately —
 * instead of Tesseract grinding, N silent passes and a bare "all OCR passes
 * failed". A success is cached for 60 s so back-to-back requests skip the hop.
 */
let _reachableAt = 0;
async function preflight(force = false) {
  if (!force && Date.now() - _reachableAt < 60000) return { ok: true, cached: true };
  try {
    const { status } = await get(`${AI_URL}/models`, 4000);
    // Any HTTP answer (even 404 on exotic builds) proves the server is there.
    if (status && status < 500) { _reachableAt = Date.now(); return { ok: true, status }; }
    return { ok: false, error: `the vision server at ${AI_URL} responded HTTP ${status} — LM Studio is reachable but unhealthy` };
  } catch (e) {
    return { ok: false, error: describeConnectionError(e.message) };
  }
}

/** Build the multimodal message array (text instruction + image_url value). */
function visionMessages(instruction, imageUrlValue, userNote) {
  const content = [{ type: 'text', text: userNote ? `${instruction}\n\nExtra context from the user: ${userNote}` : instruction }];
  content.push({ type: 'image_url', image_url: imageUrlValue });
  return [{ role: 'user', content }];
}

// Mime types the llama.cpp / LM Studio vision loaders decode reliably.
// Everything else — WebP above all (stb_image cannot read it), HEIC/AVIF/TIFF —
// makes the backend reject the request even though the encoding shape is right.
// PC uploads are often WebP (images saved from the web) while phone cameras
// produce JPEG, which is exactly why "it fails on PC but works on mobile".
const SAFE_IMAGE_MIME = /image\/(jpe?g|png)/i;

/**
 * Fit the image to the vision server's appetite:
 *  - any non-JPEG/PNG format is TRANSCODED to JPEG (WebP et al.), and
 *  - anything over OCR_LLM_MAX_MB is downscaled (longest side OCR_LLM_MAX_DIM),
 * both via ImageMagick. Without ImageMagick the original is sent unchanged and
 * the eventual backend error gets a clear install hint appended (see decorate).
 * Cached per image object so multi-pass runs don't re-convert every call.
 */
const _fitCache = new WeakMap();
async function fitForModel(image, b64, mime) {
  const oversize = LLM_MAX_MB > 0 && b64.length * 0.75 > LLM_MAX_MB * 1024 * 1024;
  const exotic = !SAFE_IMAGE_MIME.test(mime || '');
  if (!oversize && !exotic) return { b64, mime, exotic, converted: false };
  const key = image && typeof image === 'object' ? image : null;
  if (key && _fitCache.has(key)) return _fitCache.get(key);
  let out = { b64, mime, exotic, converted: false };
  try {
    const small = await imageQuality.downscale(Buffer.from(b64, 'base64'), mime, { maxDim: LLM_MAX_DIM });
    // Always adopt the JPEG for exotic inputs; for size-only cases adopt it
    // when it actually shrank the payload.
    if (small && (exotic || small.buffer.length < b64.length * 0.75)) {
      out = { b64: small.buffer.toString('base64'), mime: small.mime, exotic, converted: true };
    }
  } catch { /* best-effort — send the original */ }
  if (key) _fitCache.set(key, out);
  return out;
}

/**
 * Probe ONE image format with a tiny non-streaming request (1×1 PNG, 4 tokens).
 * Throws with the server's own words when rejected.
 */
async function probeFormat(fmt) {
  const messages = visionMessages('Reply with the single word: OK', fmt.build(PROBE_PNG_B64, 'image/png'), '');
  const payload = JSON.stringify({ model: AI_MODEL, messages, max_tokens: 4, temperature: 0, stream: false });
  const { status, body } = await post(`${AI_URL}/chat/completions`, headers(Buffer.byteLength(payload)), payload, 30000);
  if (status === 200) return;
  const e = new Error(`vision model HTTP ${status}: ${String(body || '').slice(0, 300)}`);
  e.status = status;
  throw e;
}

/**
 * Find the image encoding the RUNNING server accepts, once, with cheap probes —
 * never inside a real (possibly streaming) OCR call, which can't be retried
 * after the first token. The winner is cached until the server complains again
 * (LM Studio restart/upgrade), then re-negotiated. OCR_IMAGE_MODE only sets
 * which format is probed first.
 */
let _negotiating = null; // concurrent calls share one probe run
async function negotiateFormat(force = false) {
  if (_negotiated && !force) return IMAGE_FORMATS.find((f) => f.id === _negotiated);
  if (_negotiating) return _negotiating;
  _negotiating = (async () => {
    const attempts = [];
    for (const fmt of orderedFormats()) {
      try {
        await probeFormat(fmt);
        _negotiated = fmt.id;
        return fmt;
      } catch (e) {
        attempts.push(`${fmt.id} → ${e.message}`);
        // Only a 4xx means "the server disliked this request shape; try another".
        // Network errors / timeouts / 5xx are the server's problem — surface them.
        if (!(e.status >= 400 && e.status < 500)) throw e;
      }
    }
    throw new Error(`the vision server rejected every known image encoding. Probe results: ${attempts.join(' | ')}`);
  })();
  try { return await _negotiating; } finally { _negotiating = null; }
}

/**
 * Core vision call. The image format is negotiated UP FRONT via probeFormat()
 * (cached across calls), the image is size-guarded via fitForModel(), and if
 * the server still complains about the encoding mid-flight (it was restarted
 * with a different build, say) the format is re-negotiated once and the call
 * retried — unless tokens were already streamed to the client.
 *   opts: { instruction, image:{buffer,mime}|dataUrl, note, temperature, maxTokens, onChunk }
 * Connection-class failures (LM Studio down / wrong IP / firewall) are rewritten
 * into an actionable message carrying the target URL — see describeConnectionError.
 */
async function visionCall(opts) {
  try {
    return await visionCallInner(opts);
  } catch (e) {
    if (isConnectionError(e.message) && !/cannot reach the vision server/.test(e.message)) {
      throw new Error(describeConnectionError(e.message));
    }
    throw e;
  }
}

async function visionCallInner({ instruction, image, note = '', temperature = TEMPERATURE, maxTokens = MAX_TOKENS, onChunk }) {
  const raw = toImage(image);
  const fit = await fitForModel(image, raw.b64, raw.mime);
  const { b64, mime } = fit;
  const stream = typeof onChunk === 'function';
  const url = `${AI_URL}/chat/completions`;

  // When an exotic format (WebP/HEIC/…) could NOT be transcoded because
  // ImageMagick is missing, tell the user exactly that on failure — the
  // backend's own error rarely mentions the image format.
  const decorate = (e) => {
    if (fit.exotic && !fit.converted) {
      e.message += ` | NOTE: the uploaded image is ${raw.mime || 'an unknown format'} — many vision backends cannot decode it. Install ImageMagick on the OCR server (sudo apt install imagemagick) so it is converted to JPEG automatically, or upload a JPEG/PNG.`;
    }
    return e;
  };

  let fmt = await negotiateFormat();
  for (let attempt = 0; ; attempt++) {
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
        if (status !== 200) throw new Error(`vision model HTTP ${status}: ${body.slice(0, 300)}`);
        out = JSON.parse(body)?.choices?.[0]?.message?.content?.trim() || '';
      }
      if (!out || !String(out).trim()) {
        // A silent empty answer is a failure, not a result — and it must never
        // consecrate the current format as "working".
        const e = new Error('vision model returned an empty response');
        e.empty = true;
        throw e;
      }
      return out;
    } catch (e) {
      if (isPayloadError(e.message)) {
        throw decorate(new Error(`the image is too large for the vision server (${Math.round(b64.length * 0.75 / 1024 / 1024 * 10) / 10} MB sent). Install ImageMagick so the server can downscale automatically (OCR_LLM_MAX_MB/OCR_LLM_MAX_DIM), or upload a smaller photo. Server said: ${e.message}`));
      }
      // The negotiated format stopped working (server restarted with another
      // build?) or the answer came back empty: re-probe once and retry.
      if (attempt === 0 && !emitted && (isImageFormatError(e.message) || e.empty)) {
        _negotiated = null;
        fmt = await negotiateFormat(true);
        continue;
      }
      throw decorate(e);
    }
  }
}

// ── Adaptive extraction pipeline (deps injected; see extractionPipeline.js) ───
const pipeline = createPipeline({
  visionCall,
  structurePrompt: STRUCTURE_PROMPT,
  withReference,
  parseJsonLoose,
  referenceOcr,
  textOcr,
  quality: imageQuality,
});

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Transcribe a receipt image to faithful Markdown.
 *   transcribe(image, { note, onChunk })   image = {buffer,mime} or a data-URL
 * If onChunk is provided the response is streamed and the full text is returned
 * when done; otherwise a single blocking call is made.
 */
async function transcribe(image, { note = '', onChunk, ref } = {}) {
  if (ref === undefined) ref = pipeline.config.refMode === 'never' ? '' : await referenceOcr(image);
  return visionCall({ instruction: withReference(TRANSCRIBE_PROMPT, ref), image, note, onChunk });
}

/**
 * The dictation-repair transcription (default single-pass flow):
 *   1. MAIN read of the image (this text's numbers/structure are authoritative);
 *   2. SECOND independent read (step A — evidence for what garbled words meant);
 *   3. fix pass (streamed): rewrite MAIN fixing only misspelled Persian words.
 * A deterministic guard then verifies the fix changed NO digit run and kept a
 * sane length — otherwise the MAIN text wins. Every failure path falls back to
 * MAIN, so this can only ever improve on the old single-pass behaviour.
 */
async function transcribeWithSpellfix(image, { note = '', onChunk, onStatus, ref = '' } = {}) {
  if (onStatus) onStatus({ phase: 'main-read' });
  const main = await visionCall({ instruction: withReference(TRANSCRIBE_PROMPT, ref), image, note });

  let second = '';
  try {
    if (onStatus) onStatus({ phase: 'second-read' });
    // a touch of temperature so the second read fails differently than the first
    second = await visionCall({ instruction: TRANSCRIBE_PROMPT, image, note, temperature: OCR_DRAFT_TEMP });
  } catch { /* no second source → main stands */ }
  if (!second.trim()) { if (onChunk) onChunk(main); return main; }

  try {
    if (onStatus) onStatus({ phase: 'spellfix' });
    const fixed = await visionCall({ instruction: spellfixInstruction(main, second), image, note, temperature: 0, onChunk });
    // Word fixes only: identical numbers, comparable length — else MAIN wins.
    const lengthSane = fixed.length >= main.length * 0.6 && fixed.length <= main.length * 1.6;
    if (P.sameDigitRuns(main, fixed) && lengthSane) return fixed;
    return main;
  } catch {
    if (onChunk) onChunk(main);
    return main;
  }
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

  // ── Adaptive plan (fixes the clean-receipt regression) ──────────────────────
  // Probe the image quality first. CLEAN receipts take the single-pass,
  // clean-room path that always worked best for them: no Tesseract text in the
  // prompt (its unlabelled ID numbers are what tempted the model to treat them
  // as prices) and no redundant draft passes. POOR images get the full arsenal:
  // reference-OCR grounding + multi-pass reconciliation. OCR_ADAPTIVE=false
  // restores the previous fixed behaviour; OCR_REF_MODE=always|never overrides
  // the grounding decision either way.
  let probe = { quality: 'unknown' };
  if (pipeline.config.adaptive && image && image.buffer) {
    try { probe = await imageQuality.assess(Buffer.from(image.buffer), image.mime); } catch { /* keep unknown */ }
  }
  if (pipeline.config.adaptive && probe.quality === 'clean') passes = 1;
  const useRef = pipeline.config.refMode === 'always' ||
    (pipeline.config.refMode === 'auto' && (!pipeline.config.adaptive || probe.quality !== 'clean'));

  // Reference OCR once, reused across every pass (grounds digits everywhere).
  const ref = useRef ? await referenceOcr(image) : '';
  if (passes <= 1) {
    if (!SPELLFIX) return transcribe(image, { note, onChunk, ref });
    return transcribeWithSpellfix(image, { note, onChunk, onStatus, ref });
  }

  const draftInstruction = withReference(TRANSCRIBE_PROMPT, ref);
  // 1) draft passes (non-streaming, a little temperature for useful diversity).
  const drafts = [];
  let lastErr = null;
  for (let i = 0; i < passes; i++) {
    if (onStatus) onStatus({ phase: 'draft', pass: i + 1, of: passes });
    try {
      const d = await visionCall({ instruction: draftInstruction, image, note, temperature: OCR_DRAFT_TEMP });
      if (d && d.trim()) drafts.push(d.trim());
    } catch (e) {
      lastErr = e;
      // A connection-class failure hits every pass identically — abort with the
      // real reason NOW instead of burning N silent retries into a generic error.
      if (isConnectionError(e.message) || /cannot reach the vision server/.test(e.message)) throw e;
      /* otherwise a single failed pass shouldn't sink the batch */
    }
  }
  // When every pass failed, surface the REAL underlying error — "all OCR passes
  // failed" alone told nobody that e.g. the vision server was rejecting the
  // image encoding or the payload size.
  if (!drafts.length) throw new Error(`all OCR passes failed${lastErr ? ` — ${lastErr.message}` : ''}`);
  if (drafts.length === 1) { if (onChunk) onChunk(drafts[0]); return drafts[0]; }

  // 2) reconciliation pass — image + reference OCR + all drafts, deterministic.
  if (onStatus) onStatus({ phase: 'reconcile', of: passes });
  const attempts = drafts.map((d, i) => `### Attempt ${i + 1}\n${d}`).join('\n\n');
  const instruction = withReference(`${RECONCILE_PROMPT}\n\n--- OCR ATTEMPTS ---\n${attempts}`, ref);
  return visionCall({ instruction, image, note, temperature: 0, onChunk });
}

/**
 * Extract a structured JSON invoice object from a receipt image, through the
 * adaptive self-verifying pipeline (quality probe → extraction → deterministic
 * checks → targeted repair rounds → words-win fixes).
 * Returns { data, raw, verification } — `data` is the verified object (null if
 * the model never returned valid JSON) with `data.verification` carrying the
 * checks, confidence and warnings; `raw` is the model's last raw string.
 * Pass `transcription` (the receipt's OCR text, if already available) so the
 * verifier can ground the amount-in-words / currency / identifier checks.
 */
async function extractStructured(image, { note = '', transcription = '', onStatus } = {}) {
  return pipeline.extract(image, { note, transcription, onStatus });
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
    const m = String(e.message || e);
    return { ok: false, error: isConnectionError(m) ? describeConnectionError(m) : m, url: AI_URL, model: AI_MODEL };
  }
}

module.exports = {
  transcribe, transcribeRefined, extractStructured, testConnection, getConfig,
  // reachability preflight — controllers call this before starting any OCR work
  preflight,
  // exposed for the vision-format/connection tests (and reusable by callers
  // that need a single raw model call): the core call + the error classifiers.
  visionCall, isImageFormatError, isPayloadError, isConnectionError,
};

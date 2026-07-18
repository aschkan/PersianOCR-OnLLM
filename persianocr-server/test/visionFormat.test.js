'use strict';
/**
 * Tests for the image-format negotiation refactor, against a fake LM Studio
 * that reproduces the exact production failure:
 *   "Invalid 'content': 'image_url' field must be an object in the form
 *    { image_url: { url: \"...base64 encoded image here...\" } }"
 * The old in-band negotiation could cache a broken format, dissolve server
 * errors into empty transcriptions ("all OCR passes failed") and die inside
 * streaming calls. The new flow probes formats up front with a tiny image,
 * re-negotiates when the server changes its mind, and surfaces real errors.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const OBJ_ERR = `Invalid 'content': 'image_url' field must be an object in the form { image_url: { url: "...base64 encoded image here..." } }`;
const RAW_ERR = `'url' field must be a base64 encoded image.`;

let server, ocr;
let mode = 'raw-b64-only';   // which image encoding the fake server accepts
let emptyOnce = false;       // next REAL call answers 200 with empty content
let decodeFail = false;      // real calls fail like a backend that can't read the image bytes
let script = null;           // scripted reply contents (one per call), for flow tests
const seen = [];             // { probe, kind } per request, in order

// kind of image_url the client sent: 'dataurl-obj' | 'raw-obj' | 'string'
function classify(imageUrl) {
  if (typeof imageUrl === 'string') return 'string';
  if (imageUrl && typeof imageUrl.url === 'string') return imageUrl.url.startsWith('data:') ? 'dataurl-obj' : 'raw-obj';
  return 'other';
}

before(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      const j = JSON.parse(body);
      const iu = (j.messages[0].content.find((c) => c.type === 'image_url') || {}).image_url;
      const kind = classify(iu);
      const probe = j.max_tokens === 4;
      seen.push({ probe, kind });

      const reject = (msg) => { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: msg })); };
      if (mode === 'payload') return reject('context length exceeded: the request is too long');
      if (kind === 'string') return reject(OBJ_ERR);
      if (mode === 'raw-b64-only' && kind !== 'raw-obj') return reject(kind === 'dataurl-obj' ? RAW_ERR : OBJ_ERR);
      if (mode === 'dataurl-only' && kind !== 'dataurl-obj') return reject(OBJ_ERR);
      if (!probe && decodeFail) return reject('Failed to process the image: unknown or unsupported format');

      let content = script && script.length ? script.shift() : 'OK-' + kind;
      if (!probe && emptyOnce) { emptyOnce = false; content = ''; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content } }] }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  process.env.OCR_AI_URL = `http://127.0.0.1:${server.address().port}/v1`;
  process.env.OCR_TESSERACT = 'false';   // keep the module free of local tools
  process.env.OCR_LLM_MAX_MB = '0';      // no downscaling in tests
  ocr = require('../Services/ocrService');
});

after(() => server && server.close());

const IMAGE = { buffer: Buffer.from('not-really-a-jpeg'), mime: 'image/jpeg' };

test('negotiates via probes: data-URL rejected → raw base64 wins, real call uses it', async () => {
  const out = await ocr.visionCall({ instruction: 'x', image: IMAGE });
  assert.equal(out, 'OK-raw-obj');
  // probe(dataurl)=400 → probe(raw)=200 → real call with the winner
  assert.deepEqual(seen.map((s) => `${s.probe ? 'probe' : 'call'}:${s.kind}`),
    ['probe:dataurl-obj', 'probe:raw-obj', 'call:raw-obj']);
  // the winner is cached — a second call goes straight through, no probes
  seen.length = 0;
  await ocr.visionCall({ instruction: 'x', image: IMAGE });
  assert.deepEqual(seen.map((s) => s.probe), [false]);
});

test('server switches builds: cached format re-negotiated automatically', async () => {
  mode = 'dataurl-only';
  seen.length = 0;
  const out = await ocr.visionCall({ instruction: 'x', image: IMAGE });
  assert.equal(out, 'OK-dataurl-obj');
  // cached raw format fails with the format complaint → re-probe → retry
  assert.equal(seen[0].probe, false);
  assert.equal(seen[0].kind, 'raw-obj');
  assert.ok(seen.some((s) => s.probe && s.kind === 'dataurl-obj'));
  assert.equal(seen[seen.length - 1].kind, 'dataurl-obj');
});

test('empty 200 answers are failures, not results (no more silent "")', async () => {
  emptyOnce = true;
  const out = await ocr.visionCall({ instruction: 'x', image: IMAGE });
  assert.equal(out, 'OK-dataurl-obj');   // retried after the empty answer
});

test('payload/context errors are surfaced with guidance, not format-cycled', async () => {
  mode = 'payload';
  await assert.rejects(
    () => ocr.visionCall({ instruction: 'x', image: IMAGE }),
    (e) => /too large for the vision server/.test(e.message) && /context length/.test(e.message)
  );
  mode = 'dataurl-only';
});

test('undecodable WebP: failure names the format and the ImageMagick fix', async () => {
  decodeFail = true;
  // "UklGR…" — the WebP signature seen in the production LM Studio log.
  const webp = { buffer: Buffer.from('UklGRfake-webp-bytes'), mime: 'image/webp' };
  await assert.rejects(
    () => ocr.visionCall({ instruction: 'x', image: webp }),
    (e) => /image\/webp/.test(e.message) && /ImageMagick/.test(e.message)
  );
  decodeFail = false;
});

test('dictation fix: word repairs accepted, digit changes rejected', async () => {
  const MAIN = 'عبلغ به عحد : ۱۲،۰۰۰،۰۰۰ ریال به حروف : دوازده میلیون ریال';
  const SECOND = 'مبلغ به عدد : 12,000,000 ریال به حروف : دوازده میلیون ریال';
  const GOOD = 'مبلغ به عدد : ۱۲،۰۰۰،۰۰۰ ریال به حروف : دوازده میلیون ریال';
  const BAD = 'مبلغ به عدد : ۱۲۰،۰۰۰،۰۰۰ ریال به حروف : دوازده میلیون ریال';

  script = [MAIN, SECOND, GOOD];               // main read → second read → fix
  assert.equal(await ocr.transcribeRefined(IMAGE), GOOD);

  script = [MAIN, SECOND, BAD];                // fix added a zero → MAIN wins
  assert.equal(await ocr.transcribeRefined(IMAGE), MAIN);
  script = null;
});

test('classifiers recognise the exact production error strings', () => {
  assert.equal(ocr.isImageFormatError(OBJ_ERR), true);
  assert.equal(ocr.isImageFormatError(RAW_ERR), true);
  assert.equal(ocr.isImageFormatError('connect ECONNREFUSED'), false);
  assert.equal(ocr.isPayloadError('HTTP 413 payload too large'), true);
  assert.equal(ocr.isPayloadError('context length exceeded'), true);
  assert.equal(ocr.isPayloadError(OBJ_ERR), false);
});

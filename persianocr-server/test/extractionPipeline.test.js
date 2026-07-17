'use strict';
/** End-to-end tests of the adaptive self-verifying pipeline with a scripted
 *  fake vision model — no LLM, no Tesseract, no ImageMagick needed. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createPipeline } = require('../Services/extractionPipeline');

const STRUCTURE_PROMPT = 'EXTRACT-JSON (base prompt)';
const REF_TEXT = 'شماره چک : ۱۲۳۴۵۶\nشماره مرجع : ۹۹۸۸۷۶۶'; // ID-laden Tesseract text
const TRANSCRIPTION = [
  'سند دریافت',
  'مبلغ به عدد : ۱۲۰،۰۰۰،۰۰۰ ریال به حروف : دوازده میلیون ریال',
  'شماره چک : ۱۲۳۴۵۶ | مبلغ (ریال) : ۵،۰۰۰،۰۰۰',
  'نوع : ATM | شماره مرجع : ۹۹۸۸۷۶۶ | مبلغ (ریال) : ۷،۰۰۰،۰۰۰',
  'جمع به حروف : دوازده میلیون ریال',
].join('\n');

const IMAGE = { buffer: Buffer.from('fake-image'), mime: 'image/jpeg' };

// Minimal loose-JSON parser mirroring the production one.
function parseJsonLoose(s) {
  if (!s) return null;
  const t = String(s).trim();
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(t.slice(a, b + 1)); } catch { return null; }
}

const withReference = (instruction, ref) => (ref ? `${instruction}\n--- REFERENCE OCR ---\n${ref}` : instruction);

/** Build a pipeline whose "model" replies from a script (one reply per call). */
function fakePipeline(replies, { quality = 'clean', config = {}, onCall } = {}) {
  const calls = [];
  return {
    calls,
    pipeline: createPipeline({
      visionCall: async (opts) => {
        calls.push(opts);
        if (onCall) onCall(opts);
        const r = replies[Math.min(calls.length - 1, replies.length - 1)];
        return typeof r === 'string' ? r : JSON.stringify(r);
      },
      structurePrompt: STRUCTURE_PROMPT,
      withReference,
      parseJsonLoose,
      referenceOcr: async () => REF_TEXT,
      textOcr: { available: () => false, ocrWords: async () => [] },
      quality: {
        assess: async () => ({ quality, width: 1000, height: 1400, reasons: quality === 'poor' ? ['low contrast'] : [] }),
        enhance: async () => null,
        cropBand: async () => null,
        status: () => ({}),
      },
      config: Object.assign({ fixRounds: 2 }, config),
    }),
  };
}

test('clean image: reference OCR text stays OUT of the prompt (regression fix)', async () => {
  const { pipeline, calls } = fakePipeline([{ total: 12000000, currency: 'IRR', items: [] }]);
  const { data } = await pipeline.extract(IMAGE, { transcription: TRANSCRIPTION });
  assert.equal(calls.length, 1);
  assert.ok(!calls[0].instruction.includes('REFERENCE OCR'), 'clean receipts must get a clean-room prompt');
  assert.equal(data.total, 12000000);
});

test('poor image (or OCR_REF_MODE=always): reference OCR grounding is included', async () => {
  const poor = fakePipeline([{ total: 12000000, currency: 'IRR', items: [] }], { quality: 'poor' });
  await poor.pipeline.extract(IMAGE, { transcription: TRANSCRIPTION });
  assert.ok(poor.calls[0].instruction.includes('REFERENCE OCR'));

  const always = fakePipeline([{ total: 12000000, currency: 'IRR', items: [] }], { config: { refMode: 'always' } });
  await always.pipeline.extract(IMAGE, { transcription: TRANSCRIPTION });
  assert.ok(always.calls[0].instruction.includes('REFERENCE OCR'));
});

test('added zero: repair round gets targeted feedback; model fixes it', async () => {
  const wrong = { total: 120000000, currency: 'IRR', items: [{ name: 'چک', qty: null, unitPrice: null, total: 5000000 }, { name: 'ATM', qty: null, unitPrice: null, total: 7000000 }] };
  const right = Object.assign({}, wrong, { total: 12000000, amountInWords: 'دوازده میلیون ریال' });
  const { pipeline, calls } = fakePipeline([wrong, right]);
  const { data, verification } = await pipeline.extract(IMAGE, { transcription: TRANSCRIPTION });
  assert.equal(calls.length, 2);
  assert.ok(calls[1].instruction.includes('VERIFICATION FAILED'));
  assert.ok(calls[1].instruction.includes('factor of ten'));
  assert.equal(data.total, 12000000);
  assert.equal(verification.checks.wordsMatchDigits, true);
  assert.equal(verification.passes, 2);
});

test('model never yields: deterministic fixes still deliver the right answer', async () => {
  // The model insists on the extra zero, the wrong currency AND a cheque number
  // as a unit price — every repair round returns the same bad JSON.
  const stubborn = {
    total: 120000000, currency: 'IRT',
    items: [{ name: 'چک', qty: null, unitPrice: 123456, total: 5000000 }, { name: 'ATM', qty: null, unitPrice: null, total: 7000000 }],
  };
  const { pipeline, calls } = fakePipeline([stubborn]);
  const { data, verification } = await pipeline.extract(IMAGE, { transcription: TRANSCRIPTION });
  assert.equal(calls.length, 3);                       // 1 extract + 2 repair rounds
  assert.equal(data.total, 12000000);                  // words + line sum win
  assert.equal(data.currency, 'IRR');                  // printed unit wins
  assert.equal(data.items[0].unitPrice, null);         // identifier evicted
  assert.equal(data.identifiers.cheque, '123456');
  assert.equal(verification.corrected, true);
  assert.ok(verification.warnings.length >= 3);
  assert.ok(verification.confidence <= 1);
  // and the final object passes every check
  for (const [name, val] of Object.entries(verification.checks)) {
    assert.notEqual(val, false, `check ${name} must not fail after fixes`);
  }
});

test('invalid JSON first, valid on repair', async () => {
  const { pipeline, calls } = fakePipeline(['sorry, no JSON here', { total: 12000000, currency: 'IRR', items: [] }]);
  const { data } = await pipeline.extract(IMAGE, { transcription: TRANSCRIPTION });
  assert.equal(calls.length, 2);
  assert.ok(calls[1].instruction.includes('not valid JSON'));
  assert.equal(data.total, 12000000);
});

test('OCR_VERIFY=false short-circuits to the plain single call', async () => {
  const { pipeline, calls } = fakePipeline([{ total: 120000000, currency: 'IRR', items: [] }], { config: { verify: false } });
  const { data, verification } = await pipeline.extract(IMAGE, { transcription: TRANSCRIPTION });
  assert.equal(calls.length, 1);
  assert.equal(data.total, 120000000);   // untouched — verification disabled
  assert.equal(verification.checks, null);
});

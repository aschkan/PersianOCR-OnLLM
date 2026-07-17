'use strict';
/**
 * Tests for the connectivity refactor: when Express cannot reach LM Studio at
 * all (box off, server not started, wrong IP, firewall), the user must get the
 * REAL reason and the target URL immediately — never a bare
 * "all OCR passes failed" after N silent retries.
 */
const { test, before } = require('node:test');
const assert = require('node:assert/strict');

// 127.0.0.1:9 (discard port, nothing listens) → instant ECONNREFUSED.
const DEAD_URL = 'http://127.0.0.1:9/v1';
let ocr;

before(() => {
  process.env.OCR_AI_URL = DEAD_URL;
  process.env.OCR_TESSERACT = 'false';
  process.env.OCR_LLM_MAX_MB = '0';
  ocr = require('../Services/ocrService');
});

const IMAGE = { buffer: Buffer.from('fake'), mime: 'image/jpeg' };

test('preflight reports unreachable server with URL and actionable hint', async () => {
  const pre = await ocr.preflight();
  assert.equal(pre.ok, false);
  assert.match(pre.error, /cannot reach the vision server/);
  assert.ok(pre.error.includes(DEAD_URL.replace('/v1', '') + '/v1'));
  assert.match(pre.error, /connection refused|no response|does not resolve/i);
});

test('visionCall rewrites raw socket errors into the friendly diagnostic', async () => {
  await assert.rejects(
    () => ocr.visionCall({ instruction: 'x', image: IMAGE }),
    (e) => /cannot reach the vision server/.test(e.message) && /ECONNREFUSED/.test(e.message)
  );
});

test('multi-pass aborts on the FIRST connection failure with the real reason', async () => {
  const t0 = Date.now();
  await assert.rejects(
    () => ocr.transcribeRefined(IMAGE, { passes: 3 }),
    (e) => /cannot reach the vision server/.test(e.message) && !/all OCR passes failed/.test(e.message)
  );
  // one instant ECONNREFUSED, not three passes worth of retries/timeouts
  assert.ok(Date.now() - t0 < 5000, 'must fail fast');
});

test('testConnection also carries the friendly diagnostic', async () => {
  const r = await ocr.testConnection();
  assert.equal(r.ok, false);
  assert.match(r.error, /cannot reach the vision server/);
});

test('connection classifier: sockets yes, model complaints no', () => {
  assert.equal(ocr.isConnectionError('connect ECONNREFUSED 192.168.11.165:1234'), true);
  assert.equal(ocr.isConnectionError('connect EHOSTUNREACH 192.168.11.165:1234'), true);
  assert.equal(ocr.isConnectionError('vision model timeout'), true);
  assert.equal(ocr.isConnectionError(`Invalid 'content': 'image_url' field must be an object`), false);
  assert.equal(ocr.isConnectionError('context length exceeded'), false);
});

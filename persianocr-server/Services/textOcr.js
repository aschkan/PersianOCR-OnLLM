'use strict';
/**
 * textOcr — a traditional OCR engine (Tesseract) used to GROUND the vision LLM.
 * ─────────────────────────────────────────────────────────────────────────────
 * A small vision model (gemma-3-4b) reliably misreads large Persian numbers —
 * e.g. ۲۰٬۰۰۰٬۰۰۰ ریال read as ۲۰٬۰۰۰ — and it does so consistently, so multi-pass
 * reconciliation can't catch it. Tesseract is genuinely good at DIGITS; we run it
 * on the same image and hand its text to the model as a reference so it copies
 * numbers/codes correctly (the image stays authoritative for layout + Persian
 * text, which Tesseract often garbles).
 *
 * Everything here is OPTIONAL and best-effort: if `tesseract` isn't installed the
 * module reports unavailable and the app runs LLM-only exactly as before.
 *
 * Install on Ubuntu:
 *   sudo apt install tesseract-ocr tesseract-ocr-fas      # Persian + digits
 *   sudo apt install imagemagick                          # optional pre-processing
 */
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TESS_BIN = process.env.TESSERACT_BIN || 'tesseract';
const CONVERT_BIN = process.env.IMAGEMAGICK_BIN || 'convert';
const LANG = process.env.OCR_TESSERACT_LANG || 'fas+eng';
const PSM = process.env.OCR_TESSERACT_PSM || '6';           // 6 = uniform block of text
const TIMEOUT_MS = Number(process.env.OCR_TESSERACT_TIMEOUT_MS) || 60000;

function hasBinary(bin) {
  try { const r = spawnSync(bin, ['--version'], { timeout: 5000 }); return r.status === 0 || (r.stdout && r.stdout.length > 0); }
  catch { return false; }
}

// Availability: OCR_TESSERACT=true|false forces it; otherwise auto-detect.
let _avail = null;
function available() {
  if (_avail !== null) return _avail;
  const flag = process.env.OCR_TESSERACT;
  if (flag === 'false' || flag === '0' || flag === 'no') { _avail = false; return _avail; }
  const detected = hasBinary(TESS_BIN);
  _avail = (flag === 'true' || flag === '1' || flag === 'yes') ? true : detected;
  if (_avail && !detected) _avail = false;   // forced on but binary missing → still off
  return _avail;
}

const HAS_CONVERT = (() => { try { return hasBinary(CONVERT_BIN); } catch { return false; } })();
const PREPROCESS = !/^(0|false|no)$/i.test(process.env.OCR_PREPROCESS || 'auto') && HAS_CONVERT;

function run(bin, args, timeout) {
  return new Promise((resolve) => {
    let out = Buffer.alloc(0), err = '';
    let child;
    try { child = spawn(bin, args, { timeout }); }
    catch { return resolve({ code: -1, out, err: 'spawn failed' }); }
    child.stdout.on('data', (d) => { out = Buffer.concat([out, d]); });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', () => resolve({ code: -1, out, err: 'spawn error' }));
    child.on('close', (code) => resolve({ code, out, err }));
  });
}

/**
 * OCR an image buffer to plain text. Returns '' if Tesseract is unavailable or
 * fails — the caller then just runs LLM-only.
 */
async function ocrText(buffer, mime) {
  if (!available() || !buffer || !buffer.length) return '';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pocr-tess-'));
  const ext = /png/i.test(mime || '') ? '.png' : '.jpg';
  const inPath = path.join(dir, 'in' + ext);
  let target = inPath;
  try {
    fs.writeFileSync(inPath, buffer);

    // Optional pre-processing markedly improves Tesseract on faint thermal
    // receipts: grayscale, upscale, normalise contrast, light sharpen.
    if (PREPROCESS) {
      const pre = path.join(dir, 'pre.png');
      const r = await run(CONVERT_BIN, [inPath, '-colorspace', 'Gray', '-resize', '200%', '-normalize', '-sharpen', '0x1', pre], 30000);
      if (r.code === 0 && fs.existsSync(pre)) target = pre;
    }

    const r = await run(TESS_BIN, [target, 'stdout', '-l', LANG, '--psm', PSM], TIMEOUT_MS);
    return r.code === 0 ? r.out.toString('utf8').trim() : '';
  } catch {
    return '';
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

/**
 * OCR with word bounding boxes (Tesseract TSV output) on the ORIGINAL image —
 * no preprocessing, so the coordinates map straight onto the uploaded pixels.
 * Returns [{ text, left, top, width, height, conf }] or [] when unavailable.
 * Used by the adaptive pipeline to locate the amount region for a zoomed
 * re-read; purely best-effort like everything else in this module.
 */
async function ocrWords(buffer, mime) {
  if (!available() || !buffer || !buffer.length) return [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pocr-tsv-'));
  const inPath = path.join(dir, 'in' + (/png/i.test(mime || '') ? '.png' : '.jpg'));
  try {
    fs.writeFileSync(inPath, buffer);
    const r = await run(TESS_BIN, [inPath, 'stdout', '-l', LANG, '--psm', PSM, 'tsv'], TIMEOUT_MS);
    if (r.code !== 0) return [];
    const words = [];
    for (const line of r.out.toString('utf8').split('\n').slice(1)) {
      const c = line.split('\t');
      if (c.length < 12 || c[0] !== '5') continue; // level 5 = word
      const text = (c[11] || '').trim();
      if (!text) continue;
      words.push({ text, left: +c[6], top: +c[7], width: +c[8], height: +c[9], conf: +c[10] });
    }
    return words;
  } catch {
    return [];
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

function status() {
  return { available: available(), lang: LANG, preprocess: PREPROCESS, bin: TESS_BIN };
}

module.exports = { available, ocrText, ocrWords, status };

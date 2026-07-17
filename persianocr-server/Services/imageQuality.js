'use strict';
/**
 * imageQuality — cheap per-image assessment + optional ImageMagick helpers.
 * ─────────────────────────────────────────────────────────────────────────────
 * The adaptive pipeline decides HOW to read each receipt (passes, reference
 * OCR, enhancement, crops) from a quick quality probe of the actual pixels:
 *
 *   assess()   `identify` → width/height/mean/stddev → 'clean' | 'poor' | 'unknown'
 *   enhance()  grayscale + upscale + normalise + sharpen (for faint thermal shots)
 *   cropBand() cut a horizontal band (the amount region) and upscale it 2×
 *
 * Everything is best-effort: without ImageMagick, assess() returns 'unknown'
 * and enhance()/cropBand() return null — callers fall back to the original
 * image, exactly like the pre-existing Tesseract preprocessing does.
 */
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CONVERT_BIN = process.env.IMAGEMAGICK_BIN || 'convert';
const IDENTIFY_BIN = process.env.IMAGEMAGICK_IDENTIFY_BIN || 'identify';
// Below this min-dimension the image is considered low-res for OCR purposes.
const MIN_DIM = Number(process.env.OCR_QUALITY_MIN_DIM) || 640;
// Below this luma standard deviation the image is considered low-contrast.
const MIN_STDDEV = Number(process.env.OCR_QUALITY_MIN_STDDEV) || 0.10;

function hasBinary(bin) {
  try { const r = spawnSync(bin, ['--version'], { timeout: 5000 }); return r.status === 0 || (r.stdout && r.stdout.length > 0); }
  catch { return false; }
}
const HAS_IDENTIFY = hasBinary(IDENTIFY_BIN);
const HAS_CONVERT = hasBinary(CONVERT_BIN);

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

function tmpFile(buffer, mime) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pocr-img-'));
  const p = path.join(dir, 'in' + (/png/i.test(mime || '') ? '.png' : '.jpg'));
  fs.writeFileSync(p, buffer);
  return { dir, p, cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } } };
}

/**
 * Probe the image. → { quality, width, height, mean, stddev, reasons[] }.
 * quality: 'clean' (well-lit, sharp-enough print), 'poor' (small / low-contrast /
 * washed-out / very dark — lean on every helper we have), 'unknown' (no identify).
 */
async function assess(buffer, mime) {
  const out = { quality: 'unknown', width: 0, height: 0, mean: null, stddev: null, reasons: [] };
  if (!HAS_IDENTIFY || !buffer || !buffer.length) return out;
  const t = tmpFile(buffer, mime);
  try {
    const r = await run(IDENTIFY_BIN, ['-format', '%w %h %[fx:mean] %[fx:standard_deviation]', t.p + '[0]'], 15000);
    if (r.code !== 0) return out;
    const [w, h, mean, stddev] = r.out.toString('utf8').trim().split(/\s+/).map(Number);
    if (!w || !h) return out;
    Object.assign(out, { width: w, height: h, mean, stddev });
    if (Math.min(w, h) < MIN_DIM) out.reasons.push(`low resolution (${w}x${h})`);
    if (Number.isFinite(stddev) && stddev < MIN_STDDEV) out.reasons.push(`low contrast (stddev ${stddev.toFixed(3)})`);
    if (Number.isFinite(mean) && mean > 0.97) out.reasons.push(`washed out (mean ${mean.toFixed(3)})`);
    if (Number.isFinite(mean) && mean < 0.08) out.reasons.push(`very dark (mean ${mean.toFixed(3)})`);
    out.quality = out.reasons.length ? 'poor' : 'clean';
    return out;
  } finally { t.cleanup(); }
}

/**
 * Enhance a poor image for reading: grayscale, upscale to a workable size,
 * normalise contrast, light sharpen. → { buffer, mime:'image/png' } or null.
 */
async function enhance(buffer, mime) {
  if (!HAS_CONVERT || !buffer || !buffer.length) return null;
  const t = tmpFile(buffer, mime);
  try {
    const outPath = path.join(t.dir, 'out.png');
    const r = await run(CONVERT_BIN, [t.p + '[0]', '-auto-orient', '-colorspace', 'Gray', '-resize', '200%', '-normalize', '-sharpen', '0x1', outPath], 30000);
    if (r.code !== 0 || !fs.existsSync(outPath)) return null;
    return { buffer: fs.readFileSync(outPath), mime: 'image/png' };
  } catch { return null; } finally { t.cleanup(); }
}

/**
 * Crop a horizontal band [top..bottom] (pixel rows) across the full width and
 * upscale it 2× — used to zoom into the amount region for a focused re-read.
 * → { buffer, mime:'image/png' } or null.
 */
async function cropBand(buffer, mime, { top, bottom, width, height }) {
  if (!HAS_CONVERT || !buffer || !buffer.length) return null;
  const y = Math.max(0, Math.floor(top));
  const h = Math.max(1, Math.min(Math.ceil(bottom - top), (height || bottom) - y));
  const t = tmpFile(buffer, mime);
  try {
    const outPath = path.join(t.dir, 'crop.png');
    const geometry = `${Math.max(1, Math.floor(width || 0)) || ''}x${h}+0+${y}`;
    const r = await run(CONVERT_BIN, [t.p + '[0]', '-auto-orient', '-crop', geometry, '+repage', '-resize', '200%', outPath], 30000);
    if (r.code !== 0 || !fs.existsSync(outPath)) return null;
    return { buffer: fs.readFileSync(outPath), mime: 'image/png' };
  } catch { return null; } finally { t.cleanup(); }
}

function status() {
  return { identify: HAS_IDENTIFY, convert: HAS_CONVERT, minDim: MIN_DIM, minStddev: MIN_STDDEV };
}

module.exports = { assess, enhance, cropBand, status };

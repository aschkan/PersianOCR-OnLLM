/**
 * compressImage — shrink a picked receipt photo IN THE BROWSER before upload.
 *
 * Phone photos and PC screenshots easily reach 5-20 MB (PNG screenshots
 * especially); the vision server doesn't need anywhere near that for OCR.
 * Any file over `maxBytes` (1 MB) is decoded, scaled and re-encoded as JPEG,
 * walking down a quality/dimension ladder until it fits under the cap. That
 * cuts upload time and keeps the request inside the vision server's limits.
 *
 * Entirely best-effort: any decode/encode failure (odd format, HEIC without
 * browser support, ancient browser) returns the ORIGINAL file untouched — the
 * server has its own ImageMagick downscale guard as the second line.
 */

// Hard target for the uploaded image ("maximum image size 1 MB").
export const MAX_UPLOAD_BYTES = 1024 * 1024;

// Formats the local vision backends (llama.cpp/LM Studio) often CANNOT decode —
// WebP above all (PC images saved from the web are usually WebP, which is why
// OCR "worked on mobile but not on PC"). These are ALWAYS re-encoded to JPEG,
// regardless of size.
const REENCODE_TYPES = /image\/(webp|heic|heif|tiff?|gif|avif|bmp)/i;

// Re-encode attempts, best quality first. 2000 px longest side is more than
// enough for receipt OCR; the floor (1000 px / 0.5) still reads fine.
const LADDER = [
  { dim: 2000, quality: 0.85 },
  { dim: 2000, quality: 0.7 },
  { dim: 1600, quality: 0.7 },
  { dim: 1600, quality: 0.55 },
  { dim: 1200, quality: 0.55 },
  { dim: 1000, quality: 0.5 },
];

/** Decode via createImageBitmap (honours EXIF orientation) with an <img> fallback. */
async function decode(file) {
  if (typeof createImageBitmap === 'function') {
    try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); }
    catch { /* Safari < 15 rejects the options bag; retry plain */ }
    try { return await createImageBitmap(file); } catch { /* fall through */ }
  }
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = (e) => { URL.revokeObjectURL(url); reject(e); };
    img.src = url;
  });
}

function toBlob(canvas, type, quality) {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

function render(src, w, h, dim, quality) {
  const scale = Math.min(1, dim / Math.max(w, h));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(w * scale));
  canvas.height = Math.max(1, Math.round(h * scale));
  const ctx = canvas.getContext('2d');
  // white backdrop: transparent PNG screenshots must not become black JPEGs
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, canvas.width, canvas.height);
  return toBlob(canvas, 'image/jpeg', quality);
}

/**
 * maybeCompressImage(file, opts?) → Promise<File>
 * JPEG/PNG at or under `maxBytes` pass through untouched. Bigger files come
 * back as a JPEG under the cap (or the smallest achievable), and WebP/HEIC/…
 * are converted to JPEG even when small — the vision backend can't read them.
 * Never throws.
 */
export async function maybeCompressImage(file, { maxBytes = MAX_UPLOAD_BYTES } = {}) {
  try {
    if (!file || !/^image\//.test(file.type)) return file;
    const tooBig = file.size > maxBytes;
    const badType = REENCODE_TYPES.test(file.type);
    if (!tooBig && !badType) return file;

    const src = await decode(file);
    const w = src.width || src.naturalWidth;
    const h = src.height || src.naturalHeight;
    if (!w || !h) return file;

    let best = null;
    for (const step of LADDER) {
      const blob = await render(src, w, h, step.dim, step.quality);
      if (blob && (!best || blob.size < best.size)) best = blob;
      if (blob && blob.size <= maxBytes) break;
    }
    if (src.close) src.close();

    if (!best) return file;
    // For a decodable-but-oversized JPEG/PNG, keep the original if re-encoding
    // somehow made it bigger. A bad TYPE must convert no matter what.
    if (!badType && best.size >= file.size) return file;

    const name = (file.name || 'receipt').replace(/\.[^.]*$/, '') + '.jpg';
    return new File([best], name, { type: 'image/jpeg', lastModified: file.lastModified || Date.now() });
  } catch {
    return file;
  }
}

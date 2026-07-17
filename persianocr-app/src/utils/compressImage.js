/**
 * compressImage — shrink a picked receipt photo IN THE BROWSER before upload.
 *
 * Phone photos and PC screenshots easily reach 5-20 MB (PNG screenshots
 * especially); the vision server doesn't need anywhere near that for OCR.
 * If the file is bigger than `maxBytes`, it is decoded, scaled so its longest
 * side is at most `maxDim`, and re-encoded as JPEG. That cuts upload time and
 * keeps the request under the vision server's payload limits.
 *
 * Entirely best-effort: any decode/encode failure (odd format, HEIC without
 * browser support, ancient browser) returns the ORIGINAL file untouched — the
 * server has its own ImageMagick downscale guard as the second line.
 */

const DEFAULTS = {
  maxBytes: 2 * 1024 * 1024, // only touch files bigger than this ("a little big")
  maxDim: 2400,              // longest side after compression — plenty for OCR
  quality: 0.85,             // JPEG quality
};

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

/**
 * maybeCompressImage(file, opts?) → Promise<File>
 * Returns a smaller JPEG File when compression is worthwhile, otherwise the
 * original file. Never throws.
 */
export async function maybeCompressImage(file, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  try {
    if (!file || !/^image\//.test(file.type) || file.size <= o.maxBytes) return file;

    const src = await decode(file);
    const w = src.width || src.naturalWidth;
    const h = src.height || src.naturalHeight;
    if (!w || !h) return file;

    const scale = Math.min(1, o.maxDim / Math.max(w, h));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(w * scale));
    canvas.height = Math.max(1, Math.round(h * scale));
    const ctx = canvas.getContext('2d');
    // white backdrop: transparent PNG screenshots must not become black JPEGs
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, 0, 0, canvas.width, canvas.height);
    if (src.close) src.close();

    const blob = await toBlob(canvas, 'image/jpeg', o.quality);
    // keep the original when compression didn't actually help
    if (!blob || (blob.size >= file.size && scale === 1)) return file;

    const name = (file.name || 'receipt').replace(/\.[^.]*$/, '') + '.jpg';
    return new File([blob], name, { type: 'image/jpeg', lastModified: file.lastModified || Date.now() });
  } catch {
    return file;
  }
}

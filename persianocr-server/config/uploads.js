/**
 * Upload handling for receipt images.
 * Images arrive in memory (multer memoryStorage) so the controller can both
 * (a) hand the bytes straight to the vision model as a base64 data-URL, and
 * (b) persist the original to disk under UPLOAD_DIR for the history view.
 */
const path = require('path');
const fs = require('fs');
const multer = require('multer');

const UPLOAD_DIR = path.isAbsolute(process.env.UPLOAD_DIR || 'uploads')
  ? (process.env.UPLOAD_DIR || 'uploads')
  : path.join(__dirname, '..', process.env.UPLOAD_DIR || 'uploads');

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const MAX_MB = Number(process.env.UPLOAD_MAX_MB) || 20;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_MB * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (/^image\//.test(file.mimetype)) return cb(null, true);
    cb(new Error('Only image files are accepted'));
  },
});

const EXT = { 'image/jpeg': '.jpg', 'image/jpg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif', 'image/bmp': '.bmp', 'image/heic': '.heic', 'image/heif': '.heif' };

function extFor(mime) { return EXT[String(mime).toLowerCase()] || '.img'; }

/** Persist a buffer to disk as `<id><ext>`; returns the stored filename. */
function saveImage(id, buffer, mime) {
  const filename = `${id}${extFor(mime)}`;
  fs.writeFileSync(path.join(UPLOAD_DIR, filename), buffer);
  return filename;
}

function imagePath(filename) { return path.join(UPLOAD_DIR, path.basename(filename || '')); }

function readImage(filename) {
  const p = imagePath(filename);
  return fs.existsSync(p) ? fs.readFileSync(p) : null;
}

function removeImage(filename) {
  try { if (filename) fs.unlinkSync(imagePath(filename)); } catch { /* already gone */ }
}

/** Build a base64 data-URL the vision model can consume. */
function dataUrl(buffer, mime) {
  return `data:${mime || 'image/jpeg'};base64,${buffer.toString('base64')}`;
}

module.exports = { UPLOAD_DIR, MAX_MB, upload, saveImage, imagePath, readImage, removeImage, dataUrl };

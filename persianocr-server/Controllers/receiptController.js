/**
 * receiptController — upload a Persian receipt image, run the vision-LLM OCR,
 * store the result, and serve the history.
 *
 * The OCR itself lives in Services/ocrService; this controller owns persistence,
 * the streaming response protocol, and the export/download formats.
 */
const mongoose = require('mongoose');
const Receipt = require('../Models/Receipt');
const ocr = require('../Services/ocrService');
const { saveImage, readImage, removeImage, imagePath } = require('../config/uploads');
const { AppError } = require('../Middleware/errorHandler');

const fs = require('fs');

// Fields safe/light enough for the history list (never ships the full text).
const LIST_FIELDS = 'originalName mime size status model durationMs createdAt error structured.merchant structured.total structured.currency';

function snippet(text, n = 160) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n) + '…' : s;
}

/**
 * POST /api/receipts/stream  (multipart: image, note?)
 * Streams the transcription token-by-token as text/plain while it is generated,
 * and persists the receipt server-side. The new receipt id is returned up-front
 * in the `X-Receipt-Id` response header so the client can link to it afterwards.
 */
exports.createStream = async (req, res, next) => {
  if (!req.file) return next(new AppError('No image uploaded (field "image")', 400));
  const note = (req.body?.note || '').toString().slice(0, 500);

  const id = new mongoose.Types.ObjectId();
  let imageFile = '';
  try {
    imageFile = saveImage(id.toString(), req.file.buffer, req.file.mimetype);
  } catch (e) { return next(new AppError('Could not store the uploaded image', 500)); }

  const doc = await Receipt.create({
    _id: id,
    originalName: req.file.originalname || '',
    imageFile,
    mime: req.file.mimetype,
    size: req.file.size,
    note,
    status: 'processing',
    model: ocr.getConfig().model,
  });

  // Streaming headers. Send the id before the body so the client has it early.
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('X-Receipt-Id', id.toString());
  res.setHeader('X-Accel-Buffering', 'no'); // don't let any proxy buffer the stream
  res.flushHeaders?.();

  const started = Date.now();
  try {
    const image = { buffer: req.file.buffer, mime: req.file.mimetype };
    const full = await ocr.transcribeRefined(image, { note, onChunk: (t) => res.write(t) });
    doc.text = full;
    doc.status = 'done';
    doc.durationMs = Date.now() - started;
    await doc.save();
    res.end();
  } catch (err) {
    doc.status = 'error';
    doc.error = String(err.message || err);
    doc.durationMs = Date.now() - started;
    await doc.save().catch(() => {});
    // Headers are already sent — surface the failure inline so the client sees it.
    if (!res.writableEnded) res.end(`\n\n⚠️ OCR failed: ${doc.error}`);
  }
};

/**
 * POST /api/receipts  (multipart: image, note?)
 * Blocking variant: runs the OCR and returns the finished receipt as JSON.
 */
exports.create = async (req, res, next) => {
  if (!req.file) return next(new AppError('No image uploaded (field "image")', 400));
  const note = (req.body?.note || '').toString().slice(0, 500);

  const id = new mongoose.Types.ObjectId();
  const imageFile = saveImage(id.toString(), req.file.buffer, req.file.mimetype);
  const doc = await Receipt.create({
    _id: id,
    originalName: req.file.originalname || '',
    imageFile,
    mime: req.file.mimetype,
    size: req.file.size,
    note,
    status: 'processing',
    model: ocr.getConfig().model,
  });

  const started = Date.now();
  try {
    doc.text = await ocr.transcribeRefined({ buffer: req.file.buffer, mime: req.file.mimetype }, { note });
    doc.status = 'done';
    doc.durationMs = Date.now() - started;
    await doc.save();
    res.status(201).json({ success: true, receipt: doc });
  } catch (err) {
    doc.status = 'error';
    doc.error = String(err.message || err);
    doc.durationMs = Date.now() - started;
    await doc.save().catch(() => {});
    next(new AppError(`OCR failed: ${doc.error}`, 502));
  }
};

/** GET /api/receipts?limit=&skip=&status= — newest-first history. */
exports.list = async (req, res, next) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 30, 100);
    const skip = Math.max(Number(req.query.skip) || 0, 0);
    const filter = {};
    if (req.query.status) filter.status = req.query.status;

    const [items, total] = await Promise.all([
      Receipt.find(filter).select(LIST_FIELDS).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      Receipt.countDocuments(filter),
    ]);
    res.json({ success: true, total, count: items.length, receipts: items });
  } catch (err) { next(err); }
};

/** GET /api/receipts/:id — full document (includes transcription + structured). */
exports.getOne = async (req, res, next) => {
  try {
    const doc = await Receipt.findById(req.params.id).lean();
    if (!doc) return next(new AppError('Receipt not found', 404));
    res.json({ success: true, receipt: { ...doc, snippet: snippet(doc.text) } });
  } catch (err) { next(err); }
};

/** GET /api/receipts/:id/image — serve the original uploaded image. */
exports.image = async (req, res, next) => {
  try {
    const doc = await Receipt.findById(req.params.id).select('imageFile mime').lean();
    if (!doc || !doc.imageFile) return next(new AppError('Image not found', 404));
    const p = imagePath(doc.imageFile);
    if (!fs.existsSync(p)) return next(new AppError('Image file missing on disk', 404));
    res.setHeader('Content-Type', doc.mime || 'image/jpeg');
    res.setHeader('Cache-Control', 'private, max-age=86400');
    fs.createReadStream(p).pipe(res);
  } catch (err) { next(err); }
};

/**
 * POST /api/receipts/:id/structure — run structured (JSON) extraction on the
 * stored image and save the result on the receipt.
 */
exports.structure = async (req, res, next) => {
  try {
    const doc = await Receipt.findById(req.params.id);
    if (!doc) return next(new AppError('Receipt not found', 404));
    const buf = readImage(doc.imageFile);
    if (!buf) return next(new AppError('Original image is no longer available', 410));

    // The stored transcription grounds the verifier's amount-in-words /
    // currency / identifier checks (the pipeline works without it too).
    const { data, raw, verification } = await ocr.extractStructured(
      { buffer: buf, mime: doc.mime },
      { note: doc.note, transcription: doc.text }
    );
    if (!data) return next(new AppError('Model did not return valid JSON', 502));
    doc.structured = data;
    await doc.save();
    res.json({ success: true, structured: doc.structured, verification, raw });
  } catch (err) { next(new AppError(`Extraction failed: ${err.message || err}`, 502)); }
};

/** POST /api/receipts/:id/reprocess — re-run the transcription on the stored image. */
exports.reprocess = async (req, res, next) => {
  try {
    const doc = await Receipt.findById(req.params.id);
    if (!doc) return next(new AppError('Receipt not found', 404));
    const buf = readImage(doc.imageFile);
    if (!buf) return next(new AppError('Original image is no longer available', 410));

    const started = Date.now();
    doc.text = await ocr.transcribeRefined({ buffer: buf, mime: doc.mime }, { note: doc.note });
    doc.status = 'done';
    doc.error = '';
    doc.durationMs = Date.now() - started;
    doc.model = ocr.getConfig().model;
    await doc.save();
    res.json({ success: true, receipt: doc });
  } catch (err) { next(new AppError(`OCR failed: ${err.message || err}`, 502)); }
};

/** PATCH /api/receipts/:id — let the user correct the transcription text. */
exports.update = async (req, res, next) => {
  try {
    const doc = await Receipt.findById(req.params.id);
    if (!doc) return next(new AppError('Receipt not found', 404));
    if (typeof req.body.text === 'string') doc.text = req.body.text;
    if (typeof req.body.note === 'string') doc.note = req.body.note.slice(0, 500);
    await doc.save();
    res.json({ success: true, receipt: doc });
  } catch (err) { next(err); }
};

/** DELETE /api/receipts/:id — remove the document and its image file. */
exports.remove = async (req, res, next) => {
  try {
    const doc = await Receipt.findById(req.params.id);
    if (!doc) return next(new AppError('Receipt not found', 404));
    removeImage(doc.imageFile);
    await doc.deleteOne();
    res.json({ success: true, message: 'Deleted' });
  } catch (err) { next(err); }
};

/** GET /api/receipts/:id/export?format=txt|md|json|csv — downloadable result. */
exports.exportOne = async (req, res, next) => {
  try {
    const format = (req.query.format || 'txt').toLowerCase();
    const doc = await Receipt.findById(req.params.id).lean();
    if (!doc) return next(new AppError('Receipt not found', 404));
    const base = `receipt-${doc._id}`;

    if (format === 'json') {
      send(res, `${base}.json`, 'application/json; charset=utf-8', JSON.stringify(doc, null, 2));
    } else if (format === 'md') {
      send(res, `${base}.md`, 'text/markdown; charset=utf-8', doc.text || '');
    } else if (format === 'csv') {
      send(res, `${base}.csv`, 'text/csv; charset=utf-8', itemsToCsv(doc.structured));
    } else {
      // txt = the transcription with markdown table pipes kept as-is
      send(res, `${base}.txt`, 'text/plain; charset=utf-8', doc.text || '');
    }
  } catch (err) { next(err); }
};

function send(res, filename, type, body) {
  res.setHeader('Content-Type', type);
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  // Prepend a UTF-8 BOM to text downloads (txt/md/csv). Once saved to disk the
  // HTTP charset is lost, so editors/viewers fall back to the system codepage and
  // render Persian as mojibake (Ø¯Ø±ÛŒ…). The BOM makes them detect UTF-8. JSON is
  // left as-is — a BOM breaks strict JSON parsers and browsers already show it.
  const isText = /^text\//.test(type);
  res.send(isText ? '\uFEFF' + body : body);
}

function itemsToCsv(structured) {
  const items = (structured && structured.items) || [];
  const rows = [['name', 'qty', 'unitPrice', 'total']];
  for (const it of items) rows.push([it.name ?? '', it.qty ?? '', it.unitPrice ?? '', it.total ?? '']);
  return rows.map((r) => r.map(csvCell).join(',')).join('\r\n');
}
function csvCell(v) {
  const s = String(v ?? '');
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** GET /api/ocr/status — vision-model reachability + effective config. */
exports.ocrStatus = async (_req, res) => {
  const test = await ocr.testConnection();
  res.json({ success: true, ...test, config: ocr.getConfig() });
};

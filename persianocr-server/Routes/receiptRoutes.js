const express = require('express');
const router = express.Router();

const { upload } = require('../config/uploads');
const c = require('../Controllers/receiptController');

// ── OCR backend status (vision model reachability) ────────────────────────────
router.get('/ocr/status', c.ocrStatus);

// ── Receipts ──────────────────────────────────────────────────────────────────
router.post('/receipts/stream', upload.single('image'), c.createStream); // streamed OCR
router.post('/receipts', upload.single('image'), c.create);              // blocking OCR
router.get('/receipts', c.list);
router.get('/receipts/:id', c.getOne);
router.get('/receipts/:id/image', c.image);
router.get('/receipts/:id/export', c.exportOne);
router.post('/receipts/:id/structure', c.structure);
router.post('/receipts/:id/reprocess', c.reprocess);
router.patch('/receipts/:id', c.update);
router.delete('/receipts/:id', c.remove);

module.exports = router;

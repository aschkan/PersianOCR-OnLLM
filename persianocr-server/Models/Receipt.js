const mongoose = require('mongoose');

/**
 * Receipt — one uploaded image and the OCR result the vision LLM produced for it.
 * The original image is stored on disk (UPLOAD_DIR); only its filename lives here
 * so the document stays small and the db-history backups stay light.
 */
const itemSchema = new mongoose.Schema(
  {
    name: String,
    qty: Number,
    unitPrice: Number,
    total: Number,
  },
  { _id: false }
);

const structuredSchema = new mongoose.Schema(
  {
    merchant: String,
    branch: String,
    address: String,
    phone: String,
    invoiceNumber: String,
    date: String,
    time: String,
    items: [itemSchema],
    subtotal: Number,
    discount: Number,
    tax: Number,
    total: Number,
    currency: String,
    paymentMethod: String,
  },
  { _id: false, strict: false }
);

const receiptSchema = new mongoose.Schema(
  {
    // ── source image ──────────────────────────────────────────────────────────
    originalName: { type: String, default: '' },
    imageFile: { type: String, default: '' }, // filename inside UPLOAD_DIR
    mime: { type: String, default: '' },
    size: { type: Number, default: 0 },
    note: { type: String, default: '' }, // optional user hint passed to the model

    // ── OCR result ──────────────────────────────────────────────────────────────
    status: { type: String, enum: ['processing', 'done', 'error'], default: 'processing', index: true },
    text: { type: String, default: '' }, // faithful Markdown transcription
    structured: { type: structuredSchema, default: undefined },

    // ── run metadata ────────────────────────────────────────────────────────────
    model: { type: String, default: '' },
    durationMs: { type: Number, default: 0 },
    error: { type: String, default: '' },
  },
  { timestamps: true }
);

// Newest-first history listing.
receiptSchema.index({ createdAt: -1 });

module.exports = mongoose.model('Receipt', receiptSchema);

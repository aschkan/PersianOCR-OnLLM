/**
 * ╔══════════════════════════════════════════════════════╗
 * ║           PERSIAN OCR — ON LLM · API SERVER          ║
 * ║  Express + Mongoose · Persian receipt OCR via a       ║
 * ║  local vision LLM (LM Studio, gemma-3-4b-it)          ║
 * ╚══════════════════════════════════════════════════════╝
 *
 * Upload a Persian receipt (printed, tabular, or handwritten) → the vision model
 * transcribes it faithfully to Markdown and can also extract a structured JSON
 * invoice. Runs standalone in dev, or as a plain-HTTP upstream behind the
 * platform reverse proxy in production.
 *
 * Start dev:   npm run dev
 * Start prod:  npm start
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const path = require('path');
const fs = require('fs');

const connectDB = require('./config/db');
const { errorHandler } = require('./Middleware/errorHandler');
const receiptRoutes = require('./Routes/receiptRoutes');

// ── App init ──────────────────────────────────────────────────────────────────
const app = express();
// We sit behind exactly one proxy hop (the platform reverse proxy terminates
// TLS). Trusting a specific hop count — not `true` — keeps req.ip correct without
// letting clients spoof X-Forwarded-For to bypass IP rate limiting.
app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS) || 1);
const PORT = Number(process.env.PORT) || 5004; // dev / plain-HTTP port

// ── Malformed-URL guard ───────────────────────────────────────────────────────
// Bots probe for things like /cgi-bin/%%32%65… which throw deep in Express's
// router (decodeURIComponent) and spam the logs. Reject them cleanly.
app.use((req, res, next) => {
  try { decodeURIComponent(req.path); return next(); }
  catch { return res.status(400).type('text').send('Bad Request'); }
});

// ── Connect to MongoDB ────────────────────────────────────────────────────────
connectDB();

// ── Security headers ──────────────────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: false,
}));

// ── CORS ──────────────────────────────────────────────────────────────────────
// Reflect any origin in dev; use CORS_ORIGINS (comma-separated) as an allow-list
// in production.
const allowList = (process.env.CORS_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
app.use(cors({
  origin: allowList.length ? allowList : true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

// ── Rate limiting ─────────────────────────────────────────────────────────────
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many requests, please try again later.' },
});
// OCR is expensive (a vision-model call per upload) — cap it tighter per IP.
const ocrLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many OCR requests, please slow down.' },
});
app.use(globalLimiter);

// ── Body parsing ──────────────────────────────────────────────────────────────
// JSON only for small metadata bodies (PATCH text edits). Image uploads are
// multipart and handled by multer inside the routes.
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

// ── HTTP request logging (dev only) ──────────────────────────────────────────
if (process.env.NODE_ENV === 'development') {
  app.use(morgan('dev'));
}

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({
    success: true,
    status: 'OK',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development',
  });
});

// ╔══════════════════════════════════════════════════════╗
// ║                     API ROUTES                       ║
// ╚══════════════════════════════════════════════════════╝
// The OCR endpoints (upload → vision model) carry the tighter limiter.
app.use('/api', ocrLimiter, receiptRoutes);

// ── 404 for unmatched API routes ─────────────────────────────────────────────
app.use('/api/*', (req, res) => {
  res.status(404).json({ success: false, message: `Route ${req.originalUrl} not found` });
});

// ── Central error handler ─────────────────────────────────────────────────────
app.use(errorHandler);

// ── React app (built bundle) ──────────────────────────────────────────────────
// The SPA is served at the site root with a client-side-routing fallback. A
// missing build is fine — the API works on its own.
const REACT_BUILD = path.join(__dirname, '../persianocr-app/build');
if (fs.existsSync(REACT_BUILD)) {
  app.use(express.static(REACT_BUILD, {
    index: false,
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('index.html')) {
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      } else if (/[\\/]static[\\/]/.test(filePath)) {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      }
    },
  }));
  app.get('*', (_req, res) => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.sendFile(path.join(REACT_BUILD, 'index.html'));
  });
}

// ── Start server ──────────────────────────────────────────────────────────────
// When BEHIND_PROXY=true this app is a plain-HTTP upstream: it binds ONE local
// port (APP_PORT) on loopback and the platform reverse proxy terminates TLS.
const BEHIND_PROXY = process.env.BEHIND_PROXY === 'true';
const HOST = process.env.HOST || (BEHIND_PROXY ? '127.0.0.1' : '0.0.0.0');
const APP_PORT = Number(process.env.APP_PORT) || PORT;

function banner(port) {
  const ocr = require('./Services/ocrService').getConfig();
  console.log(`\n🧾  PersianOCR-OnLLM server running on http://${HOST}:${port}`);
  console.log(`    Environment : ${process.env.NODE_ENV || 'development'}`);
  console.log(`    Vision model: ${ocr.model} @ ${ocr.url}`);
  console.log('  Routes mounted:');
  console.log('    POST  /api/receipts/stream   — upload + streamed OCR');
  console.log('    POST  /api/receipts          — upload + blocking OCR');
  console.log('    GET   /api/receipts          — history');
  console.log('    POST  /api/receipts/:id/structure — JSON invoice extraction');
  console.log('    GET   /api/ocr/status        — vision-model reachability\n');
}

if (require.main === module) {
  const httpMod = require('http');
  const listenPort = BEHIND_PROXY ? APP_PORT : PORT;
  httpMod.createServer(app).listen(listenPort, HOST, () => {
    banner(listenPort);
    if (BEHIND_PROXY) console.log('    ↑ BEHIND_PROXY: a reverse proxy terminates TLS and owns :80/:443\n');
  });
}

module.exports = app;

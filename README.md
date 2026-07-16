# PersianOCR-OnLLM — پرشین OCR

Turn a **Persian (Farsi) receipt** — printed, tabular, or **handwritten** — into
accurate text using a **local vision LLM** (LM Studio, `gemma-3-4b-it`). Upload an
image, watch the transcription stream in live, then optionally extract a
structured JSON invoice (merchant, items, totals). No image ever leaves your
network.

```
   ┌─────────────┐   image (base64)   ┌───────────────────────┐
   │  React app  │ ─────────────────► │  Express API (server) │
   │ upload/paste│                    │  Controllers/Services  │
   └─────────────┘ ◄───── stream ──── └──────────┬─────────────┘
        ▲  Markdown + JSON                        │ OpenAI-compatible
        │                                         ▼ /v1/chat/completions
        │                              ┌───────────────────────┐
        └──────── history (Mongo) ◄──  │ LM Studio · vision LLM │  (LAN Windows box)
                                       │  gemma-3-4b-it         │
                                       └───────────────────────┘
```

This is a sibling of the other platforms behind the **platform reverse proxy**:
it runs as a plain-HTTP upstream on its own loopback port and the proxy
terminates TLS and routes `persianocr.ir` to it.

---

## How the OCR works

The receipt image is sent to LM Studio's OpenAI-compatible
`POST /v1/chat/completions` as a **multimodal** message — a text instruction plus
the image as a base64 `image_url`. A vision model reads the pixels directly, so
there is no separate OCR engine to install.

Two focused tasks (one model call each — far more reliable on a 4B model than one
mega-prompt):

| Task | Endpoint | Output |
| --- | --- | --- |
| **Transcribe** | `POST /api/receipts/stream` | faithful Markdown of everything on the receipt (text, GFM tables, handwriting), streamed token-by-token |
| **Structure** | `POST /api/receipts/:id/structure` | strict JSON invoice: merchant, date, items[], subtotal/tax/total, currency |

The transcription prompt makes the model behave like an OCR engine, not a
chatbot: transcribe exactly, never translate or summarise, keep the original
digits, render tables as Markdown, and mark illegible handwriting with `«؟»`.

---

## Project layout

```
persianocr-server/          Express + Mongoose API
  server.js                 app wiring (BEHIND_PROXY-aware, serves the SPA)
  config/db.js              MongoDB connection
  config/uploads.js         multer (memory) + on-disk image store
  Services/ocrService.js    vision-LLM client (stream + structured + health)
  Models/Receipt.js         one upload + its OCR result
  Controllers/receiptController.js
  Routes/receiptRoutes.js
persianocr-app/             React (CRA) + Tailwind + daisyUI, RTL Persian
  src/pages/                Home (upload+OCR), History, ReceiptDetail, Settings
  src/components/           Dropzone, ResultPanel, Markdown, StructuredView, …
  build/                    committed bundle (served by Express in production)
```

## API

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/api/receipts/stream` | upload image → **streamed** transcription (id in `X-Receipt-Id`) |
| POST | `/api/receipts` | upload image → blocking transcription (JSON) |
| GET | `/api/receipts` | history (newest first) |
| GET | `/api/receipts/:id` | full result |
| GET | `/api/receipts/:id/image` | original image |
| POST | `/api/receipts/:id/structure` | extract JSON invoice |
| POST | `/api/receipts/:id/reprocess` | re-run OCR on the stored image |
| PATCH | `/api/receipts/:id` | correct the transcription text |
| DELETE | `/api/receipts/:id` | delete result + image |
| GET | `/api/receipts/:id/export?format=txt\|md\|json\|csv` | download |
| GET | `/api/ocr/status` | vision-model reachability + config |

---

## Run it locally

**1. Backend**
```bash
cd persianocr-server
cp .env.example .env          # set MONGO_URI and OCR_AI_URL (your LM Studio IP)
npm install
npm run dev                   # http://localhost:5004
```

**2. Frontend**
```bash
cd persianocr-app
npm install
npm start                     # http://localhost:3000 (proxies /api to :5004)
```

Requirements: MongoDB reachable at `MONGO_URI`, and **LM Studio** running on the
LAN with a **vision** model loaded (e.g. `gemma-3-4b-it`) and its server enabled.
Point `OCR_AI_URL` at that machine, e.g. `http://192.168.11.165:1234/v1`.

## Production (behind the platform reverse proxy)

Add the platform to the proxy's `platforms.json` (see
`platform-reverse-proxy/platforms.example.json`) and create
`env/persianocr.env` from the example. The orchestrator clones this repo, runs
`persianocr-server` as a `BEHIND_PROXY` upstream on `:8084`, and serves the
committed `persianocr-app/build` bundle. The proxy terminates TLS for
`persianocr.ir` and forwards to it.

```jsonc
{ "name": "persianocr", "repo": "https://github.com/aschkan/PersianOCR-OnLLM.git",
  "serverDir": "persianocr-server", "clientDir": "persianocr-app",
  "domain": "persianocr.ir", "appPort": 8084, "devPort": 5004,
  "envFile": "env/persianocr.env" }
```

## Notes

- **No cloud.** Images go only to your LM Studio box; nothing is sent to any
  third-party service.
- **No auth.** This is a single-purpose internal tool; add a gate at the proxy if
  you expose it publicly.
- OCR quality tracks the loaded model. A stronger vision model (larger gemma,
  Qwen2-VL, etc.) improves handwriting and dense tables — just change
  `OCR_AI_MODEL` / load it in LM Studio.

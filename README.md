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
terminates TLS and routes `ocr.arsaces.ir` to it.

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
`platform-reverse-proxy/platforms.example.json`). Its whole environment lives
**inline** in that entry — no separate env file needed. The orchestrator clones
this repo, runs `persianocr-server` as a `BEHIND_PROXY` upstream on `:8084`, and
serves the committed `persianocr-app/build` bundle. The proxy terminates TLS for
`ocr.arsaces.ir` and forwards to it.

```jsonc
{ "name": "persianocr", "repo": "https://github.com/aschkan/PersianOCR-OnLLM.git",
  "branch": "claude/persian-receipt-ocr-7dh901",   // → "main" once this is merged
  "serverDir": "persianocr-server", "clientDir": "persianocr-app",
  "domain": "ocr.arsaces.ir", "appPort": 8084, "devPort": 5004,
  "certPath": "/etc/letsencrypt/live/ocr.arsaces.ir/fullchain.pem",
  "keyPath":  "/etc/letsencrypt/live/ocr.arsaces.ir/privkey.pem",
  "env": {
    "MONGO_URI": "mongodb://127.0.0.1:27017/persianocr",
    "OCR_AI_URL": "http://192.168.11.165:1234/v1",
    "OCR_AI_MODEL": "gemma-3-4b-it",
    "CORS_ORIGINS": "https://ocr.arsaces.ir"
  } }
```

## Accuracy features

Small vision models misread dense receipts — especially large Persian amounts
(`۲۰٬۰۰۰٬۰۰۰` read as `۲۰٬۰۰۰`). Two opt-in layers fix most of this:

- **Reference OCR (Tesseract).** Install `tesseract-ocr` + `tesseract-ocr-fas`
  (and `imagemagick` for pre-processing) and the server runs Tesseract on each
  image and feeds its text to the model as a **digit reference** — the model
  copies exact numbers/codes instead of guessing. Auto-detected; status shows on
  the Settings page.
  ```bash
  sudo apt install tesseract-ocr tesseract-ocr-fas imagemagick
  ```
- **Multi-pass self-consistency (`OCR_PASSES`).** Set `OCR_PASSES=3` to transcribe
  each image several times and reconcile the attempts against the image in a final
  proof-reading pass. N+1× slower, noticeably more accurate.

Both combine, and both are just env settings (`OCR_TESSERACT`, `OCR_PASSES`). For
raw recognition of unusual fonts, also try a bigger model (`OCR_AI_MODEL`).

### Dictation repair (default on)

Single-pass transcriptions read the numbers right but often garble Persian
words («عبلغ به عحد» for «مبلغ به عدد»). With `OCR_SPELLFIX=true` (default) the
server reads the image a **second** time independently, then runs a fix pass:
rewrite the main transcription correcting **only** misspelled words, using the
second reading and the image as evidence — never touching numbers, lines or
structure. A deterministic digit-run guard then compares the numbers in both
texts; if even one digit changed, the fix is discarded and the original kept.
Costs two extra model calls; `OCR_SPELLFIX=false` restores the single call.

### Adaptive self-verifying extraction

Structured extraction (`POST /api/receipts/:id/structure`) no longer trusts the
model's JSON. Per image, the pipeline:

1. **Probes quality** (`identify`: resolution/contrast) and picks a plan.
   *Clean* receipts get one clean-room pass — no Tesseract text in the prompt,
   which is what used to tempt the model into using cheque/reference numbers as
   prices. *Poor* images get ImageMagick enhancement, reference-OCR grounding
   and extra passes.
2. **Verifies deterministically** (`Services/receiptVerify.js` +
   `Services/persianNumbers.js`, a Persian number-words parser):
   - the amount in words («به حروف …») converted to digits **is the source of
     truth** for the total (catches added/dropped zeros);
   - currency comes **only** from the printed unit (`ریال`→IRR, `تومان`→IRT);
   - `qty×unitPrice=line` and lines (−discount+tax) must sum to the total;
   - cheque/account/reference/terminal/card/phone numbers and dates must never
     appear in a money field.
3. **Repairs**: failed checks are fed back to the model verbatim for up to
   `OCR_FIX_ROUNDS` re-reads, optionally with a zoomed crop of the مبلغ region
   (Tesseract word boxes + ImageMagick) as extra evidence.
4. **Fixes deterministically** whatever the model keeps getting wrong (words
   win; identifiers evicted; unit-derived currency), nulls what can't be
   trusted, and returns `verification`: the checks that passed, a confidence
   score and plain-language warnings (stored on the receipt and in the API
   response).

Tune with `OCR_VERIFY`, `OCR_ADAPTIVE`, `OCR_FIX_ROUNDS`, `OCR_REF_MODE`,
`OCR_CROP_RETRY`, `OCR_ENHANCE_FOR_LLM`, `OCR_QUALITY_MIN_DIM`,
`OCR_QUALITY_MIN_STDDEV` (see `.env.example`). Every step degrades gracefully
when a tool is missing. The accuracy logic is pure and tested: `npm test` in
`persianocr-server/`.

### Image delivery that works on every LM Studio build

Different LM Studio / llama.cpp builds accept the image in different request
shapes (data-URL object vs raw-base64 object) and reject the rest with errors
like `'image_url' field must be an object …`. The server now **probes** the
formats once with a tiny built-in image, caches the one your build accepts, and
re-negotiates automatically if LM Studio is restarted with a different build —
so streaming OCR calls never have to guess. Errors the model server reports
(even inside an HTTP 200 stream) are surfaced verbatim instead of collapsing
into `all OCR passes failed`.

Oversized uploads are handled twice: the web app compresses any picture over
**1 MB** in the browser before upload (JPEG, walking a quality/size ladder down
until it fits), and the server downscales anything still above
`OCR_LLM_MAX_MB` (default 1 MB) to `OCR_LLM_MAX_DIM` (default 2048 px) with
ImageMagick before sending it to the vision server.

**WebP/HEIC uploads are converted to JPEG.** llama.cpp/LM Studio vision
loaders typically cannot decode WebP (or HEIC/AVIF/TIFF) — and images saved
from the web on a PC are usually WebP, which is why OCR could "work on mobile
but fail on PC". The browser re-encodes those formats to JPEG before upload
regardless of size, and the server transcodes any non-JPEG/PNG with
ImageMagick as the backstop (without ImageMagick the error now names the
format and the fix instead of failing cryptically).

**Fail fast when LM Studio is unreachable.** Every OCR endpoint now runs a
4-second reachability preflight first. If the GPU box is off, LM Studio's
server isn't started, the IP is wrong or a firewall is in the way, the UI
immediately shows the target URL plus what to check (e.g. *connection refused —
open LM Studio → Developer → Start Server, enable "Serve on Local Network"*)
instead of a generic `all OCR passes failed`. Connection errors also abort
multi-pass runs on the first failure, and the Settings page's status check
reports the same diagnostic.

## Notes

- **No cloud.** Images go only to your LM Studio box (and the local Tesseract);
  nothing is sent to any third-party service.
- **No auth.** This is a single-purpose internal tool; add a gate at the proxy if
  you expose it publicly.
- OCR quality tracks the loaded model. A stronger vision model (larger gemma,
  Qwen2-VL, etc.) improves handwriting and dense tables — just change
  `OCR_AI_MODEL` / load it in LM Studio.

/**
 * Central API client for the PersianOCR-OnLLM frontend.
 *
 * Same-origin '/api' in production (served by Express behind the reverse proxy);
 * override with REACT_APP_API for local dev (defaults to the CRA proxy). No auth:
 * this is a single-purpose OCR tool.
 */
const BASE = process.env.REACT_APP_API || '/api';

async function request(path, { method = 'GET', body, headers = {}, raw = false } = {}) {
  const h = { ...headers };
  let payload;
  if (body instanceof FormData) { payload = body; }
  else if (body !== undefined) { h['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }

  const res = await fetch(`${BASE}${path}`, { method, headers: h, body: payload });
  if (raw) return res;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || `Server error ${res.status}`);
  return data;
}

export const api = {
  base: BASE,

  // ── OCR backend status ──────────────────────────────────────────────────────
  ocrStatus: () => request('/ocr/status'),

  // ── Receipts ────────────────────────────────────────────────────────────────
  list: (q = '') => request(`/receipts${q}`),
  get: (id) => request(`/receipts/${id}`),
  imageUrl: (id) => `${BASE}/receipts/${id}/image`,
  exportUrl: (id, format) => `${BASE}/receipts/${id}/export?format=${format}`,

  structure: (id) => request(`/receipts/${id}/structure`, { method: 'POST' }),
  reprocess: (id) => request(`/receipts/${id}/reprocess`, { method: 'POST' }),
  updateText: (id, text) => request(`/receipts/${id}`, { method: 'PATCH', body: { text } }),
  remove: (id) => request(`/receipts/${id}`, { method: 'DELETE' }),

  /**
   * Upload an image and STREAM the transcription. Calls onToken(fullTextSoFar)
   * as tokens arrive; resolves with { id, text }. The new receipt id comes back
   * in the X-Receipt-Id header before the body starts.
   */
  transcribeStream: async (file, note, onToken) => {
    const fd = new FormData();
    fd.append('image', file);
    if (note) fd.append('note', note);
    const res = await fetch(`${BASE}/receipts/stream`, { method: 'POST', body: fd });
    if (!res.ok || !res.body) {
      const d = await res.json().catch(() => ({}));
      throw new Error(d.message || `OCR failed (${res.status})`);
    }
    const id = res.headers.get('X-Receipt-Id') || '';
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let full = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      full += dec.decode(value, { stream: true });
      onToken && onToken(full);
    }
    return { id, text: full };
  },
};

/** Copy text to the clipboard (with a legacy fallback). */
export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; }
  catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = text; document.body.appendChild(ta); ta.select();
      document.execCommand('copy'); ta.remove(); return true;
    } catch { return false; }
  }
}

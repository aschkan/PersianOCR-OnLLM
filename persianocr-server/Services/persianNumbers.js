'use strict';
/**
 * persianNumbers — pure helpers for Persian/Farsi numbers on financial documents.
 * ─────────────────────────────────────────────────────────────────────────────
 * Everything here is deterministic string/number work (no I/O, no model calls),
 * so the accuracy rules built on top of it are unit-testable:
 *
 *   normalizeDigits()      ۰-۹ / ٠-٩ → 0-9 (and ی/ک unification, ZWNJ → space)
 *   parseAmount()          "۱۲٬۰۰۰٬۰۰۰" / "12,000,000" → 12000000 (integer|null)
 *   wordsToNumber()        «دوازده میلیون و پانصد هزار» → 12500000
 *   extractAmountInWords() find the «به حروف …» phrase in a transcription
 *   detectCurrency()       the unit PRINTED next to the amount → 'IRR' | 'IRT'
 *   collectIdentifiers()   labelled non-money numbers (cheque/account/ref/…)
 */

// ── Digit / glyph normalization ───────────────────────────────────────────────
const FA_DIGITS = '۰۱۲۳۴۵۶۷۸۹';
const AR_DIGITS = '٠١٢٣٤٥٦٧٨٩';

/** Persian & Arabic-Indic digits → ASCII; Arabic ي/ك → Persian ی/ک; ZWNJ → space. */
function normalizeDigits(s) {
  if (s == null) return '';
  let out = '';
  for (const ch of String(s)) {
    const fa = FA_DIGITS.indexOf(ch);
    if (fa >= 0) { out += String(fa); continue; }
    const ar = AR_DIGITS.indexOf(ch);
    if (ar >= 0) { out += String(ar); continue; }
    if (ch === 'ي') { out += 'ی'; continue; }
    if (ch === 'ك') { out += 'ک'; continue; }
    if (ch === '‌') { out += ' '; continue; } // ZWNJ
    out += ch;
  }
  return out;
}

/** Just the digits of a value, as a string ("۱۲٬۰۰۰" → "12000"). */
function digitsOnly(s) {
  return normalizeDigits(s).replace(/[^0-9]/g, '');
}

/**
 * Parse a printed amount into an integer. Handles Persian/ASCII digits and every
 * separator seen on receipts (٬ ، , . ' and spaces). Rial/Toman amounts are
 * integers; a trailing ".00"-style fraction is dropped. Returns null when the
 * string has no digits or is already a number-free mess.
 */
function parseAmount(v) {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? Math.round(v) : null;
  let s = normalizeDigits(v).trim();
  if (!/[0-9]/.test(s)) return null;
  // Keep only the FIRST number-looking run (an amount cell may carry a unit).
  const m = s.match(/[0-9][0-9٬،,.'٬’ ]*[0-9]|[0-9]/);
  if (!m) return null;
  s = m[0];
  // Drop a decimal fraction (rial amounts are integers): "12000.50" → "12000".
  s = s.replace(/[.٫](\d{1,2})$/, '');
  const d = s.replace(/[^0-9]/g, '');
  if (!d) return null;
  const n = Number(d);
  return Number.isSafeInteger(n) ? n : null;
}

// ── Persian number words → value ──────────────────────────────────────────────
const UNITS = {
  'صفر': 0, 'یک': 1, 'دو': 2, 'سه': 3, 'چهار': 4, 'پنج': 5, 'شش': 6, 'شیش': 6,
  'هفت': 7, 'هشت': 8, 'نه': 9, 'ده': 10, 'یازده': 11, 'دوازده': 12, 'سیزده': 13,
  'چهارده': 14, 'پانزده': 15, 'پونزده': 15, 'شانزده': 16, 'شونزده': 16,
  'هفده': 17, 'هیفده': 17, 'هجده': 18, 'هیجده': 18, 'نوزده': 19,
};
const TENS = { 'بیست': 20, 'سی': 30, 'چهل': 40, 'پنجاه': 50, 'شصت': 60, 'هفتاد': 70, 'هشتاد': 80, 'نود': 90 };
const HUNDREDS = {
  'صد': 100, 'یکصد': 100, 'دویست': 200, 'سیصد': 300, 'چهارصد': 400, 'پانصد': 500,
  'پونصد': 500, 'ششصد': 600, 'شیشصد': 600, 'هفتصد': 700, 'هشتصد': 800, 'نهصد': 900,
};
const SCALES = { 'هزار': 1e3, 'میلیون': 1e6, 'ملیون': 1e6, 'میلیارد': 1e9, 'ملیارد': 1e9, 'تریلیون': 1e12 };
// Words that legitimately appear inside an amount-in-words phrase but carry no value.
const FILLERS = new Set(['و', 'ریال', 'ریالی', 'تومان', 'تومن', 'تمام', 'فقط', 'مبلغ', 'وجه', 'معادل', 'بحروف', 'حروف', 'به', 'عدد', 'کل', 'جمع']);

/**
 * Convert a Persian amount-in-words phrase to an integer.
 * «دوازده میلیون ریال» → 12000000 ; «یک میلیارد و دویست و پنجاه هزار» works too.
 * Digits embedded in the phrase ("12 میلیون") are accepted. Returns null when
 * nothing numeric is recognised. Unknown non-filler words don't abort the parse
 * (handwriting OCR is noisy) but at least one value word must be present.
 */
function wordsToNumber(phrase) {
  if (!phrase) return null;
  const tokens = normalizeDigits(phrase)
    .replace(/[،,؛:.()«»\-]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  let total = 0, chunk = 0, sawValue = false;
  for (const t of tokens) {
    if (UNITS[t] != null) { chunk += UNITS[t]; sawValue = true; continue; }
    if (TENS[t] != null) { chunk += TENS[t]; sawValue = true; continue; }
    if (HUNDREDS[t] != null) { chunk += HUNDREDS[t]; sawValue = true; continue; }
    if (SCALES[t] != null) { total += (chunk || 1) * SCALES[t]; chunk = 0; sawValue = true; continue; }
    if (/^[0-9]+$/.test(t)) { chunk += Number(t); sawValue = true; continue; }
    if (FILLERS.has(t)) continue;
    // unknown word: tolerate (names/noise), the amount words themselves are enough
  }
  if (!sawValue) return null;
  const n = total + chunk;
  return Number.isSafeInteger(n) ? n : null;
}

/**
 * Find the amount-in-words phrase in a transcription.
 * Looks for «به حروف …» / «جمع به حروف …» first, then falls back to any line that
 * combines a scale word with a currency unit. Returns { words, value, currency }
 * or null. `currency` is the unit inside the phrase itself, if any.
 */
function extractAmountInWords(text) {
  if (!text) return null;
  const t = normalizeDigits(text);
  const label = t.match(/(?:جمع\s*)?(?:مبلغ\s*)?به\s*حروف\s*[:؛]?\s*([^\n]+)/);
  const candidates = [];
  if (label) candidates.push(label[1]);
  if (!candidates.length) {
    for (const line of t.split('\n')) {
      if (/(هزار|میلیون|ملیون|میلیارد|ملیارد)/.test(line) && /(ریال|تومان|تومن)/.test(line) && !/[0-9]{4,}/.test(line)) {
        candidates.push(line);
      }
    }
  }
  for (let phrase of candidates) {
    // Cut the phrase at the currency unit so «… ریال از آقای …» stops there.
    // (no \b — it is ASCII-only and never fires after Persian letters)
    phrase = phrase.split(/(?<=ریال|تومان|تومن)/)[0] || phrase;
    const value = wordsToNumber(phrase);
    if (value != null && value > 0) {
      const currency = /تومان|تومن/.test(phrase) ? 'IRT' : (/ریال/.test(phrase) ? 'IRR' : null);
      return { words: phrase.trim(), value, currency };
    }
  }
  return null;
}

// ── Currency from the PRINTED unit ────────────────────────────────────────────
/**
 * Decide the currency from the unit printed next to the amount — never converts,
 * never assumes. Preference order: unit on a مبلغ/جمع/قابل پرداخت line → unit in
 * the amount-in-words phrase → the only unit present anywhere. Returns
 * 'IRR' | 'IRT' | null.
 */
function detectCurrency(text) {
  if (!text) return null;
  const t = normalizeDigits(text);
  const amountLines = t.split('\n').filter((l) => /(مبلغ|جمع|قابل\s*پرداخت|فی|بها)/.test(l));
  for (const l of amountLines) {
    if (/تومان|تومن/.test(l)) return 'IRT';
    if (/ریال/.test(l)) return 'IRR';
  }
  const words = extractAmountInWords(t);
  if (words && words.currency) return words.currency;
  const hasRial = /ریال/.test(t), hasToman = /تومان|تومن/.test(t);
  if (hasRial && !hasToman) return 'IRR';
  if (hasToman && !hasRial) return 'IRT';
  return null;
}

// ── Identifiers (numbers that are NEVER money) ────────────────────────────────
// label → identifier slot. Longest/most specific labels first.
const ID_LABELS = [
  { re: /شماره\s*چک|چک\s*شماره/, key: 'cheque' },
  { re: /شماره\s*حساب|حساب\s*شماره|شبا/, key: 'account' },
  { re: /شماره\s*مرجع|مرجع|پیگیری|بازیابی|رهگیری|سند\s*شماره/, key: 'reference' },
  { re: /ترمینال|پایانه|پذیرنده/, key: 'terminal' },
  { re: /کارت/, key: 'card' },
  { re: /تلفن|موبایل|همراه|تماس/, key: 'phone' },
  { re: /سریال|شناسه|کد\s*ملی/, key: 'serial' },
];

/**
 * Scan a transcription (or reference-OCR text) for labelled identifier numbers.
 * Returns { byKey: {cheque, account, …}, all: Set<digitString> }. Dates and
 * times are added to `all` too — nothing in `all` may appear in a money field.
 */
function collectIdentifiers(text) {
  const byKey = {};
  const all = new Set();
  if (!text) return { byKey, all };
  const t = normalizeDigits(text);
  for (const line of t.split('\n')) {
    for (const { re, key } of ID_LABELS) {
      if (!re.test(line)) continue;
      // every digit-run on a labelled line is an identifier, not an amount —
      // except runs that carry thousands separators AND sit next to ریال/تومان.
      const runs = line.match(/[0-9][0-9,،٬.\- *]*[0-9]|[0-9]{4,}/g) || [];
      for (const run of runs) {
        const isMoneyLike = /[,،٬]/.test(run) && /(ریال|تومان|مبلغ)/.test(line);
        if (isMoneyLike) continue;
        const d = run.replace(/[^0-9]/g, '');
        if (d.length >= 4) {
          all.add(d);
          if (!byKey[key]) byKey[key] = d;
        }
      }
    }
    // Unlabelled but unmistakable identifiers: dates, times, 16-digit cards, IBAN.
    for (const m of line.match(/\b\d{2,4}[\/.-]\d{1,2}[\/.-]\d{1,4}\b/g) || []) all.add(m.replace(/[^0-9]/g, ''));
    for (const m of line.match(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g) || []) all.add(m.replace(/[^0-9]/g, ''));
    for (const m of line.match(/\b\d{16}\b/g) || []) all.add(m);
    for (const m of line.match(/IR\d{22,24}/gi) || []) all.add(m.replace(/[^0-9]/g, ''));
  }
  return { byKey, all };
}

// ── Transcript-fix safety (the dictation-repair pass must not touch numbers) ──
/** Every digit run in the text, normalized to ASCII, in order. */
function digitRuns(text) {
  const t = normalizeDigits(text || '');
  return t.match(/[0-9]+/g) || [];
}

/**
 * True when two texts carry EXACTLY the same numbers (as a multiset of digit
 * runs — order-insensitive, separators ignored). Used to accept/reject the
 * dictation-fix pass: word fixes are welcome, any changed/added/dropped digit
 * means the "fix" is discarded and the original transcription kept.
 */
function sameDigitRuns(a, b) {
  const ra = digitRuns(a).sort();
  const rb = digitRuns(b).sort();
  if (ra.length !== rb.length) return false;
  for (let i = 0; i < ra.length; i++) if (ra[i] !== rb[i]) return false;
  return true;
}

/**
 * Deterministic quality score for a receipt transcription — used to pick the
 * BETTER of two independent reads as the base text (small vision models are a
 * lottery per run; one read often nails the amounts the other garbles).
 * Signals, strongest first:
 *   +8  the amount-in-words («دوازده میلیون ریال») is corroborated by matching
 *       digits somewhere in the same text — the single best sign of a good read
 *   +2  an amount-in-words phrase exists at all
 *   +2/each (cap 6) money-like digit runs (≥6 digits ending in 000)
 *   +0.5/each (cap 4) receipt keywords (مبلغ/جمع/تاریخ/شماره/ریال/تومان)
 *   −0.5/each (cap 4) ASCII junk tokens ("Syl", "pp", "Oy" — hallucination noise)
 *   −0.3/each «؟» uncertainty markers
 */
function transcriptScore(text) {
  if (!text || !String(text).trim()) return -1;
  const t = normalizeDigits(text);
  let score = 0;
  const words = extractAmountInWords(t);
  const runs = digitRuns(t);
  if (words && words.value != null) {
    score += 2;
    const target = String(words.value);
    const unseparated = t.replace(/[,،٬]/g, '');
    if (runs.includes(target) || unseparated.includes(target)) score += 8;
  }
  score += Math.min(6, runs.filter((r) => r.length >= 6 && /000$/.test(r)).length * 2);
  score += Math.min(4, (t.match(/مبلغ|جمع|تاریخ|شماره|ریال|تومان/g) || []).length * 0.5);
  score -= Math.min(4, (t.match(/[A-Za-z]{2,}/g) || []).length * 0.5);
  score -= (t.match(/؟/g) || []).length * 0.3;
  return score;
}

module.exports = {
  normalizeDigits,
  digitsOnly,
  parseAmount,
  wordsToNumber,
  extractAmountInWords,
  detectCurrency,
  collectIdentifiers,
  digitRuns,
  sameDigitRuns,
  transcriptScore,
};

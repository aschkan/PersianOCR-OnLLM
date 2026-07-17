'use strict';
/**
 * receiptVerify — deterministic self-verification for structured extractions.
 * ─────────────────────────────────────────────────────────────────────────────
 * The model's JSON is never trusted as-is. This module re-derives the ground
 * truth from the transcription/reference text with persianNumbers and runs the
 * checks that catch the three costly OCR errors:
 *
 *   wordsMatchDigits  «به حروف …» converted to a number == total (WORDS WIN)
 *   currencyFromUnit  currency == the unit PRINTED next to the amount
 *   arithmeticOk      qty×unitPrice == line total; lines (−discount+tax) sum up
 *   noIdAsAmount      no cheque/account/reference/terminal/card/date number
 *                     ever sits in a money field
 *   zerosPlausible    the total's digit count agrees with the words value
 *
 * verify() only DIAGNOSES (so the pipeline can re-ask the model with targeted
 * feedback); applyFixes() then PATCHES what can be fixed deterministically and
 * nulls what can't, with a warning — never a silent guess.
 * Pure functions, no I/O — fully unit-testable.
 */
const P = require('./persianNumbers');

const MONEY_FIELDS = ['subtotal', 'discount', 'tax', 'total'];

/** Coerce a model-returned structured object into clean types (numbers are
 *  integers, strings trimmed, items well-formed). Non-destructive: returns a copy. */
function coerceStructured(input) {
  const s = Object.assign({}, input || {});
  for (const f of MONEY_FIELDS) s[f] = P.parseAmount(s[f]);
  s.items = Array.isArray(s.items) ? s.items.map((it) => ({
    name: it && it.name != null ? String(it.name).trim() : '',
    qty: it ? P.parseAmount(it.qty) : null,
    unitPrice: it ? P.parseAmount(it.unitPrice) : null,
    total: it ? P.parseAmount(it.total) : null,
  })) : [];
  for (const f of ['merchant', 'branch', 'address', 'phone', 'invoiceNumber', 'date', 'time', 'amountInWords', 'paymentMethod']) {
    if (s[f] != null && typeof s[f] !== 'string') s[f] = String(s[f]);
    if (s[f] != null) s[f] = s[f].trim() || null;
  }
  if (s.currency != null) {
    const c = String(s.currency).trim();
    s.currency = /^irr$|ریال/i.test(c) ? 'IRR' : /^irt$|تومان|تومن/i.test(c) ? 'IRT' : (c.toUpperCase() || null);
  }
  if (s.identifiers && typeof s.identifiers === 'object') {
    const ids = {};
    for (const [k, v] of Object.entries(s.identifiers)) ids[k] = v == null ? null : String(v).trim() || null;
    s.identifiers = ids;
  }
  return s;
}

/** Sum of item line totals, or null when no line has one. */
function itemsSum(items) {
  let sum = 0, any = false;
  for (const it of items || []) {
    if (it.total != null) { sum += it.total; any = true; }
  }
  return any ? sum : null;
}

/** a/b is an exact power of ten (the add/drop-a-zero signature). */
function powerOfTenApart(a, b) {
  if (!a || !b) return false;
  const [hi, lo] = a > b ? [a, b] : [b, a];
  if (hi % lo !== 0) return false;
  let q = hi / lo;
  while (q % 10 === 0) q /= 10;
  return q === 1 && hi !== lo;
}

/**
 * Verify a (coerced) structured object against the document text.
 *   verify(structured, { transcription, refText })
 * → { checks, issues, wordsValue, textCurrency, identifiers }
 * `issues` are human-readable strings the pipeline feeds back to the model on a
 * repair round. Checks are true (passed), false (failed) or null (not testable).
 */
function verify(structured, ctx = {}) {
  const s = structured || {};
  const text = [ctx.transcription || '', ctx.refText || ''].filter(Boolean).join('\n');
  const issues = [];
  const checks = { wordsMatchDigits: null, currencyFromUnit: null, arithmeticOk: null, noIdAsAmount: null, zerosPlausible: null };

  // ── amount in words: the source of truth for the total ─────────────────────
  const fromText = P.extractAmountInWords(text);
  const fromModel = s.amountInWords ? P.wordsToNumber(s.amountInWords) : null;
  const wordsValue = (fromText && fromText.value) || fromModel || null;
  const wordsPhrase = (fromText && fromText.words) || s.amountInWords || null;
  if (wordsValue != null) {
    if (s.total == null) {
      checks.wordsMatchDigits = false;
      issues.push(`total is missing but the amount in words «${wordsPhrase}» = ${wordsValue}. Re-read the amount box; the words are the source of truth.`);
    } else if (s.total === wordsValue) {
      checks.wordsMatchDigits = true;
    } else {
      checks.wordsMatchDigits = false;
      const zeroHint = powerOfTenApart(s.total, wordsValue)
        ? ' The difference is exactly a factor of ten — you added or dropped a zero.'
        : '';
      issues.push(`total=${s.total} disagrees with the amount in words «${wordsPhrase}» = ${wordsValue}.${zeroHint} Re-read the printed digits; if they still disagree, the WORDS win.`);
    }
    checks.zerosPlausible = s.total == null ? null : String(s.total).length === String(wordsValue).length;
  }

  // ── currency from the printed unit only ─────────────────────────────────────
  const textCurrency = P.detectCurrency(text);
  if (textCurrency) {
    checks.currencyFromUnit = s.currency === textCurrency;
    if (!checks.currencyFromUnit) {
      issues.push(`currency="${s.currency}" but the unit printed next to the amount is ${textCurrency === 'IRR' ? '«ریال» → IRR' : '«تومان» → IRT'}. Use ONLY the printed unit; never convert.`);
    }
  }

  // ── arithmetic ───────────────────────────────────────────────────────────────
  const items = s.items || [];
  let arith = null;
  for (const it of items) {
    if (it.qty != null && it.unitPrice != null && it.total != null) {
      const ok = it.qty * it.unitPrice === it.total;
      arith = arith === null ? ok : arith && ok;
      if (!ok) issues.push(`line "${it.name}": qty ${it.qty} × unitPrice ${it.unitPrice} ≠ lineTotal ${it.total}. Re-read that row.`);
    }
  }
  const sum = itemsSum(items);
  if (sum != null && s.total != null) {
    const expected = sum - (s.discount || 0) + (s.tax || 0);
    const ok = expected === s.total || sum === s.total;
    arith = arith === null ? ok : arith && ok;
    if (!ok) issues.push(`item totals sum to ${sum} (with discount/tax → ${expected}) but total=${s.total}. One of them is misread.`);
  }
  checks.arithmeticOk = arith;

  // ── identifiers must never be money ─────────────────────────────────────────
  const identifiers = P.collectIdentifiers(text);
  if (identifiers.all.size) {
    let clash = false;
    const flag = (val, where) => {
      if (val == null) return;
      const d = String(val);
      if (d.length >= 4 && identifiers.all.has(d)) {
        clash = true;
        issues.push(`${where}=${val} is an IDENTIFIER on this document (cheque/account/reference/terminal/card/date), not an amount. Money comes only from a مبلغ/ریال/تومان column.`);
      }
    };
    for (const f of MONEY_FIELDS) flag(s[f], f);
    items.forEach((it, i) => { flag(it.unitPrice, `items[${i}].unitPrice`); flag(it.total, `items[${i}].total`); });
    checks.noIdAsAmount = !clash;
  } else {
    checks.noIdAsAmount = text ? true : null;
  }

  return { checks, issues, wordsValue, wordsPhrase, textCurrency, identifiers };
}

/** True when no check failed (nulls — untestable — don't count as failures). */
function passed(v) {
  return Object.values(v.checks).every((c) => c !== false);
}

/**
 * Deterministically patch what the model kept getting wrong, after repair
 * rounds are exhausted. Words win for the total; identifier values are evicted
 * from money fields; currency follows the printed unit. Anything irreparable
 * becomes null + a warning — never a guess. Returns { data, warnings, changed }.
 */
function applyFixes(structured, v) {
  const s = JSON.parse(JSON.stringify(structured || {}));
  const warnings = [];
  let changed = false;

  // identifiers out of money fields first (so the words/sum rules see clean data)
  const isId = (val) => val != null && String(val).length >= 4 && v.identifiers.all.has(String(val));
  for (const f of MONEY_FIELDS) {
    if (isId(s[f])) { warnings.push(`${f} (${s[f]}) matched a document identifier and was cleared`); s[f] = null; changed = true; }
  }
  for (const it of s.items || []) {
    for (const f of ['unitPrice', 'total']) {
      if (isId(it[f])) { warnings.push(`item "${it.name}" ${f} (${it[f]}) matched a document identifier and was cleared`); it[f] = null; changed = true; }
    }
  }

  // words are the source of truth for the total
  if (v.wordsValue != null && s.total !== v.wordsValue) {
    const sum = itemsSum(s.items);
    const corroborated = sum === v.wordsValue || s.subtotal === v.wordsValue || powerOfTenApart(s.total, v.wordsValue) || s.total == null;
    if (corroborated) {
      warnings.push(`total set to ${v.wordsValue} from the amount in words «${v.wordsPhrase}»${s.total != null ? ` (digits read ${s.total})` : ''}`);
      s.total = v.wordsValue;
    } else {
      warnings.push(`total (${s.total}) and amount in words «${v.wordsPhrase}» (${v.wordsValue}) disagree and nothing corroborates either; total set to the words value per policy`);
      s.total = v.wordsValue;
    }
    changed = true;
  }
  if (v.wordsValue != null && !s.amountInWords && v.wordsPhrase) { s.amountInWords = v.wordsPhrase; changed = true; }

  // currency strictly from the printed unit
  if (v.textCurrency && s.currency !== v.textCurrency) {
    warnings.push(`currency corrected to ${v.textCurrency} from the printed unit${s.currency ? ` (model said ${s.currency})` : ''}`);
    s.currency = v.textCurrency;
    changed = true;
  }

  // surface the labelled identifiers we found ourselves (never overwrites model's)
  const slots = { cheque: null, account: null, reference: null, terminal: null, card: null, phone: null, serial: null };
  s.identifiers = Object.assign(slots, v.identifiers.byKey, s.identifiers || {});

  return { data: s, warnings, changed };
}

/**
 * Confidence in [0,1]: the share of testable checks that passed, scaled down a
 * notch for every deterministic correction that was needed.
 */
function confidence(checks, warningsCount) {
  const testable = Object.values(checks).filter((c) => c !== null);
  if (!testable.length) return 0.5;
  const ratio = testable.filter(Boolean).length / testable.length;
  return Math.max(0, Math.round((0.4 + 0.6 * ratio - 0.05 * Math.min(warningsCount, 4)) * 100) / 100);
}

module.exports = { coerceStructured, verify, passed, applyFixes, confidence, itemsSum, powerOfTenApart, MONEY_FIELDS };

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

// ── Payment-row recovery ──────────────────────────────────────────────────────
// Models routinely return items:[] for tabular receipts, or mis-group the
// thousands separators (۵٬۰۰۰٬۰۰۰ read as ۵۰۰٬۰۰۰٬۰۰۰). The document itself
// carries the proof needed to fix both: the row amounts must sum to the
// amount-in-words. These helpers harvest money-like candidates from the text
// and search for the UNIQUE combination (each candidate optionally re-grouped
// by a power of ten) that sums to the words value.

/** Money-like digit runs from table lines (identifiers, dates, totals excluded). */
function extractRowCandidates(text) {
  if (!text) return [];
  const t = P.normalizeDigits(text);
  const ids = P.collectIdentifiers(t).all;
  const out = [];
  for (const line of t.split('\n')) {
    // total/words lines are not rows
    if (/به\s*حروف|به\s*عدد|جمع|مبلغ\s*کل|قابل\s*پرداخت/.test(line)) continue;
    for (const run of line.match(/[0-9][0-9,،٬]*[0-9]/g) || []) {
      const d = run.replace(/[^0-9]/g, '');
      if (d.length < 4 || ids.has(d)) continue;
      const grouped = /[,،٬]/.test(run);
      if (!grouped && !(d.length >= 6 && /000$/.test(d))) continue; // not money-like
      const n = Number(d);
      if (!Number.isSafeInteger(n) || n < 1000) continue;
      const label = (line.match(/چک|ATM|پوز|POS|کارت|نقد|حواله/) || [])[0] || '';
      out.push({ value: n, label });
      if (out.length >= 8) return out;
    }
  }
  return out;
}

/**
 * Find the row set summing EXACTLY to `target` (the words value). Each
 * candidate may be re-scaled by a power of ten (integer results only) to undo
 * separator mis-grouping. Accepted only when the solution is unambiguous:
 * exactly one value-set overall, or exactly one using unscaled values.
 * → { rows:[{value,label,exact}], allExact } or null.
 */
function recoverRows(candidates, target) {
  if (!target || !candidates || candidates.length < 2) return null;
  const cands = candidates.slice(0, 8);
  const variantsOf = (v) => {
    const set = [];
    for (let k = -6; k <= 3; k++) {
      const scaled = k >= 0 ? v * 10 ** k : v / 10 ** -k;
      if (!Number.isSafeInteger(scaled) || scaled < 1000 || scaled > target) continue;
      set.push({ value: scaled, exact: k === 0 });
    }
    return set;
  };
  const sols = [];
  const pick = (i, chosen, sum, allExact) => {
    if (sum === target && chosen.length >= 2) sols.push({ rows: chosen.slice(), allExact });
    if (i >= cands.length || sum >= target || chosen.length >= 4 || sols.length > 6) return;
    pick(i + 1, chosen, sum, allExact); // skip candidate i
    for (const v of variantsOf(cands[i].value)) {
      chosen.push({ value: v.value, label: cands[i].label, exact: v.exact });
      pick(i + 1, chosen, sum + v.value, allExact && v.exact);
      chosen.pop();
    }
  };
  pick(0, [], 0, true);
  // different scalings can produce the same value-set — dedupe on the values
  const uniq = new Map();
  for (const s of sols) {
    const k = s.rows.map((r) => r.value).sort((a, b) => a - b).join('+');
    if (!uniq.has(k) || s.allExact) uniq.set(k, s);
  }
  const list = [...uniq.values()];
  if (list.length === 1) return list[0];
  const exact = list.filter((s) => s.allExact);
  return exact.length === 1 ? exact[0] : null;
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
  const checks = { wordsMatchDigits: null, currencyFromUnit: null, arithmeticOk: null, noIdAsAmount: null, zerosPlausible: null, rowsFound: null };

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

  // ── payment rows: empty items on a tabular document ─────────────────────────
  // If the text shows ≥2 money-like row amounts while items[] is empty, try to
  // recover the rows deterministically (unique combination summing to the
  // words value, allowing separator-regrouping). Recovery success is applied
  // later by applyFixes; only an UNRECOVERABLE mismatch asks the model again.
  let rowRecovery = null;
  if (wordsValue != null && items.length === 0) {
    const candidates = extractRowCandidates(text);
    if (candidates.length >= 2) {
      rowRecovery = recoverRows(candidates, wordsValue);
      if (!rowRecovery) {
        checks.rowsFound = false;
        issues.push(`items[] is empty but the document lists row amounts (${candidates.map((c) => c.value).join(', ')}). Re-read the مبلغ (ریال) column of EVERY table row — the rows must sum to ${wordsValue}.`);
      }
    }
  } else if (items.length > 0) {
    checks.rowsFound = true;
  }

  return { checks, issues, wordsValue, wordsPhrase, textCurrency, identifiers, rowRecovery };
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

  // payment rows recovered from the document text (unique sum == words value)
  if (v.rowRecovery && !(s.items || []).length) {
    s.items = v.rowRecovery.rows.map((r, i) => ({ name: r.label || `ردیف ${i + 1}`, qty: null, unitPrice: null, total: r.value }));
    if (s.subtotal == null) s.subtotal = v.rowRecovery.rows.reduce((a, r) => a + r.value, 0);
    const sum = s.items.map((it) => it.total).join(' + ');
    warnings.push(v.rowRecovery.allExact
      ? `payment rows recovered from the document text (${sum} = total)`
      : `payment rows recovered with separator grouping corrected (${sum} = total)`);
    changed = true;
  }

  // a date is never a document number (models love putting تاریخ in شماره)
  if (s.invoiceNumber && /^\d{2,4}[/.\-]\d{1,2}[/.\-]\d{1,4}$/.test(P.normalizeDigits(s.invoiceNumber))) {
    warnings.push(`invoiceNumber (${s.invoiceNumber}) looked like a date and was cleared`);
    s.invoiceNumber = null;
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

module.exports = { coerceStructured, verify, passed, applyFixes, confidence, itemsSum, powerOfTenApart, extractRowCandidates, recoverRows, MONEY_FIELDS };

'use strict';
/** Unit tests for the deterministic verification layer — the three costly
 *  errors (extra/missing zeros, rial/toman, identifiers-as-money) must be
 *  caught and fixed without any model in the loop. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const V = require('../Services/receiptVerify');

// The real-world سند دریافت that used to break the app: printed digits carry an
// extra zero, the words and the two payment lines agree on 12,000,000 ریال,
// and the table is full of ID numbers sitting right next to money columns.
const SANAD = [
  'نرم افزاری محسن',
  'شماره : ۱۷۰',
  'تاریخ : ۱۳۹۵/۰۸/۱۳',
  'سند دریافت',
  'مبلغ به عدد : ۱۲۰،۰۰۰،۰۰۰ ریال به حروف : دوازده میلیون ریال از آقای/خانم : مشتری اول',
  'شماره چک/نوع : ۱۲۳۴۵۶ | شماره حساب/شماره مرجع : ۹۸۷۶۵ | مبلغ (ریال) : ۵،۰۰۰،۰۰۰',
  'نوع : ATM | شماره مرجع : ۹۹۸۸۷۶۶ | مبلغ (ریال) : ۷،۰۰۰،۰۰۰',
  'جمع به حروف : دوازده میلیون ریال',
].join('\n');

test('coerceStructured: strings/Persian digits → clean integers', () => {
  const s = V.coerceStructured({
    total: '۱۲٬۰۰۰٬۰۰۰', subtotal: '12,000,000', tax: null,
    items: [{ name: ' چک ', qty: '۲', unitPrice: '۲٬۵۰۰', total: '۵٬۰۰۰' }],
    currency: 'ریال', merchant: 42,
  });
  assert.equal(s.total, 12000000);
  assert.equal(s.subtotal, 12000000);
  assert.equal(s.items[0].qty, 2);
  assert.equal(s.items[0].unitPrice, 2500);
  assert.equal(s.currency, 'IRR');
  assert.equal(s.merchant, '42');
});

test('verify: catches the added zero and knows it is a power-of-ten slip', () => {
  const s = V.coerceStructured({ total: 120000000, currency: 'IRR', items: [] });
  const v = V.verify(s, { transcription: SANAD });
  assert.equal(v.wordsValue, 12000000);
  assert.equal(v.checks.wordsMatchDigits, false);
  assert.equal(v.checks.zerosPlausible, false);
  assert.ok(v.issues.some((i) => /factor of ten/.test(i)));
  assert.equal(V.passed(v), false);
});

test('verify: catches wrong currency against the printed unit', () => {
  const s = V.coerceStructured({ total: 12000000, currency: 'IRT', items: [] });
  const v = V.verify(s, { transcription: SANAD });
  assert.equal(v.textCurrency, 'IRR');
  assert.equal(v.checks.currencyFromUnit, false);
});

test('verify: catches an identifier placed in a money field (the regression)', () => {
  const s = V.coerceStructured({
    total: 12000000, currency: 'IRR',
    items: [{ name: 'چک', qty: null, unitPrice: 123456, total: 5000000 }],
  });
  const v = V.verify(s, { transcription: SANAD });
  assert.equal(v.checks.noIdAsAmount, false);
  assert.ok(v.issues.some((i) => /IDENTIFIER/.test(i)));
});

test('verify: line arithmetic and items-sum-to-total', () => {
  const bad = V.coerceStructured({
    total: 12000000, currency: 'IRR',
    items: [{ name: 'x', qty: 2, unitPrice: 3000, total: 7000 }],
  });
  assert.equal(V.verify(bad, {}).checks.arithmeticOk, false);

  const good = V.coerceStructured({
    total: 12000000, currency: 'IRR',
    items: [
      { name: 'چک', qty: null, unitPrice: null, total: 5000000 },
      { name: 'ATM', qty: null, unitPrice: null, total: 7000000 },
    ],
  });
  assert.equal(V.verify(good, { transcription: SANAD }).checks.arithmeticOk, true);
});

test('applyFixes: words win, identifiers evicted, currency from unit', () => {
  const s = V.coerceStructured({
    total: 120000000, currency: 'IRT',
    items: [
      { name: 'چک', qty: null, unitPrice: 123456, total: 5000000 },
      { name: 'ATM', qty: null, unitPrice: null, total: 7000000 },
    ],
  });
  const v = V.verify(s, { transcription: SANAD });
  const { data, warnings, changed } = V.applyFixes(s, v);
  assert.equal(changed, true);
  assert.equal(data.total, 12000000);                 // words + line sum win
  assert.equal(data.currency, 'IRR');                 // printed unit wins
  assert.equal(data.items[0].unitPrice, null);        // cheque no. evicted
  assert.equal(data.identifiers.cheque, '123456');    // …and surfaced as an id
  assert.ok(warnings.length >= 3);

  // the fixed object must now pass every check
  const v2 = V.verify(data, { transcription: SANAD });
  assert.equal(V.passed(v2), true);
});

test('applyFixes: a clean, correct extraction is left untouched', () => {
  const s = V.coerceStructured({
    total: 12000000, currency: 'IRR', amountInWords: 'دوازده میلیون ریال',
    items: [
      { name: 'چک', qty: null, unitPrice: null, total: 5000000 },
      { name: 'ATM', qty: null, unitPrice: null, total: 7000000 },
    ],
  });
  const v = V.verify(s, { transcription: SANAD });
  assert.equal(V.passed(v), true);
  const { data, warnings } = V.applyFixes(s, v);
  assert.equal(data.total, 12000000);
  assert.equal(warnings.length, 0);
});

// ── payment-row recovery (empty items + separator mis-grouping) ───────────────

// the production transcription: amounts read as 500,000,000 / 700,000,000
// (mis-grouped separators), total digits read as 1,000,000, items empty.
const GARBLED = [
  'سند دریافت',
  'مبلغ به عدد : ۱,۰۰۰,۰۰۰ ریال به حروف : دوازده میلیون ریال از آقای/خانم : مشتری اول',
  'شماره چک/دوع : ۹۸۷۶۵ شماره حساب : ۱,۲۳۴,۵۶۷ مبلغ (ریال) : ۵۰۰,۰۰۰,۰۰۰',
  'ATM ۹۸۸۸۷۶۵ مبلغ (ریال) : ۷۰۰,۰۰۰,۰۰۰',
  'جمع به حروف : دوازده میلیون ریال',
].join('\n');

test('extractRowCandidates: money rows in, identifiers/totals/dates out', () => {
  const vals = V.extractRowCandidates(SANAD).map((c) => c.value);
  assert.deepEqual(vals.sort((a, b) => a - b), [5000000, 7000000]);
  const garbled = V.extractRowCandidates(GARBLED).map((c) => c.value);
  assert.ok(garbled.includes(500000000) && garbled.includes(700000000));
  assert.ok(!garbled.includes(98765) && !garbled.includes(9888765));
});

test('recoverRows: exact sum wins; regrouped separators corrected; ambiguity refused', () => {
  // clean case: 5M + 7M = 12M
  const exact = V.recoverRows([{ value: 5000000, label: 'چک' }, { value: 7000000, label: 'ATM' }], 12000000);
  assert.ok(exact && exact.allExact);
  assert.deepEqual(exact.rows.map((r) => r.value).sort((a, b) => a - b), [5000000, 7000000]);

  // the production bug: 500,000,000 / 700,000,000 → ÷100 → 5M + 7M = 12M
  const scaled = V.recoverRows(
    [{ value: 1234567, label: '' }, { value: 500000000, label: 'چک' }, { value: 700000000, label: 'ATM' }],
    12000000
  );
  assert.ok(scaled && !scaled.allExact);
  assert.deepEqual(scaled.rows.map((r) => r.value).sort((a, b) => a - b), [5000000, 7000000]);

  // ambiguous: {12M} vs {5M,7M} both sum → refuse... {12M} alone is size 1 so
  // make it truly ambiguous with two 2-row solutions
  const ambiguous = V.recoverRows(
    [{ value: 5000000 }, { value: 7000000 }, { value: 4000000 }, { value: 8000000 }],
    12000000
  );
  assert.equal(ambiguous, null);

  assert.equal(V.recoverRows([{ value: 5000000 }], 12000000), null); // one row is no table
});

test('verify + applyFixes: production case fully repaired (rows, total, invoice no)', () => {
  const s = V.coerceStructured({
    total: 1000000, currency: 'IRR', items: [],
    amountInWords: 'دوازده میلیون ریال', invoiceNumber: '1405/08/14',
  });
  const v = V.verify(s, { transcription: GARBLED });
  assert.equal(v.checks.wordsMatchDigits, false);
  assert.ok(v.rowRecovery, 'rows must be recoverable');

  const { data, warnings } = V.applyFixes(s, v);
  assert.equal(data.total, 12000000);                              // words win
  assert.deepEqual(data.items.map((it) => it.total).sort((a, b) => a - b), [5000000, 7000000]);
  assert.equal(data.subtotal, 12000000);
  assert.equal(data.invoiceNumber, null);                          // date evicted
  assert.ok(warnings.some((w) => /separator grouping/.test(w)));

  const v2 = V.verify(data, { transcription: GARBLED });
  assert.equal(V.passed(v2), true);                                // fixed object is clean
});

test('confidence: full pass ≈ 1, failures drag it down', () => {
  assert.equal(V.confidence({ a: true, b: true, c: null }, 0), 1);
  const low = V.confidence({ a: false, b: false, c: true }, 2);
  assert.ok(low < 0.7);
});

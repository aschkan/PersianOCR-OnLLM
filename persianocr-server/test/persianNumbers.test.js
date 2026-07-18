'use strict';
/** Unit tests for the Persian number helpers — the foundation of every
 *  accuracy check. Run with: npm test (node --test). */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const P = require('../Services/persianNumbers');

test('normalizeDigits: Persian and Arabic-Indic digits → ASCII', () => {
  assert.equal(P.normalizeDigits('۱۲۳۴۵۶۷۸۹۰'), '1234567890');
  assert.equal(P.normalizeDigits('٠١٢٣٤٥٦٧٨٩'), '0123456789');
  assert.equal(P.normalizeDigits('مبلغ ۲۰٬۰۰۰٬۰۰۰ ریال'), 'مبلغ 20٬000٬000 ریال');
});

test('parseAmount: separators, Persian digits, decimals, junk', () => {
  assert.equal(P.parseAmount('۱۲٬۰۰۰٬۰۰۰'), 12000000);
  assert.equal(P.parseAmount('12,000,000'), 12000000);
  assert.equal(P.parseAmount('۵،۰۰۰،۰۰۰'), 5000000);
  assert.equal(P.parseAmount('20,000,000 ریال'), 20000000);
  assert.equal(P.parseAmount('12000.50'), 12000);   // rial amounts are integers
  assert.equal(P.parseAmount(7000000), 7000000);
  assert.equal(P.parseAmount('بدون عدد'), null);
  assert.equal(P.parseAmount(null), null);
});

test('wordsToNumber: simple, compound, mixed-digit phrases', () => {
  assert.equal(P.wordsToNumber('دوازده میلیون'), 12000000);
  assert.equal(P.wordsToNumber('دوازده میلیون ریال'), 12000000);
  assert.equal(P.wordsToNumber('یک میلیارد'), 1000000000);
  assert.equal(P.wordsToNumber('یک میلیارد و دویست و سی میلیون و پانصد هزار'), 1230500000);
  assert.equal(P.wordsToNumber('بیست میلیون ریال'), 20000000);
  assert.equal(P.wordsToNumber('سیصد و پنجاه هزار تومان'), 350000);
  assert.equal(P.wordsToNumber('هزار'), 1000);
  assert.equal(P.wordsToNumber('12 میلیون'), 12000000);
  assert.equal(P.wordsToNumber('فقط ریال'), null);
  assert.equal(P.wordsToNumber(''), null);
});

test('extractAmountInWords: finds the «به حروف» phrase and cuts at the unit', () => {
  const line = 'مبلغ به عدد : ۱۲۰،۰۰۰،۰۰۰ ریال به حروف : دوازده میلیون ریال از آقای/خانم : مشتری اول بابت : بدهی';
  const r = P.extractAmountInWords(line);
  assert.ok(r);
  assert.equal(r.value, 12000000);
  assert.equal(r.currency, 'IRR');
  const sum = P.extractAmountInWords('جمع به حروف : دوازده میلیون ریال');
  assert.equal(sum.value, 12000000);
  assert.equal(P.extractAmountInWords('هیچ مبلغی در کار نیست'), null);
});

test('detectCurrency: only the printed unit decides, never size or habit', () => {
  assert.equal(P.detectCurrency('مبلغ ۲۰٬۰۰۰٬۰۰۰ ریال'), 'IRR');
  assert.equal(P.detectCurrency('مبلغ ۵۰٬۰۰۰ تومان'), 'IRT');
  // the مبلغ line wins over a stray mention elsewhere
  assert.equal(P.detectCurrency('قیمت به تومان اعلام شد\nمبلغ ۱۲٬۰۰۰٬۰۰۰ ریال'), 'IRR');
  assert.equal(P.detectCurrency('هیچ واحدی چاپ نشده'), null);
});

test('digit-run guard: word fixes pass, any number change fails', () => {
  // the real garbled example: words wrong, numbers right
  const main = 'عبلغ به عحد : ۱۲،۰۰۰،۰۰۰ ریال به حروف : دوازده میلیون ریال\nترم اقزارهای مختلق شخصی مالی\nتاریخ ۱۳۹۵/۰۸/۱۳';
  const fixedWords = 'مبلغ به عدد : ۱۲،۰۰۰،۰۰۰ ریال به حروف : دوازده میلیون ریال\nنرم افزارهای مختلف شخصی مالی\nتاریخ ۱۳۹۵/۰۸/۱۳';
  const fixedExtraZero = main.replace('۱۲،۰۰۰،۰۰۰', '۱۲۰،۰۰۰،۰۰۰');
  const fixedDroppedLine = 'مبلغ به عدد : ۱۲،۰۰۰،۰۰۰ ریال';
  assert.deepEqual(P.digitRuns('۱۲،۰۰۰،۰۰۰ ریال'), ['12', '000', '000']);
  assert.equal(P.sameDigitRuns(main, fixedWords), true);       // dictation fix OK
  assert.equal(P.sameDigitRuns(main, fixedExtraZero), false);  // digit changed → reject
  assert.equal(P.sameDigitRuns(main, fixedDroppedLine), false); // numbers dropped → reject
});

test('transcriptScore: a read whose digits corroborate its words wins', () => {
  // the real production pair: bad read turned the amount into a "time" and
  // dropped the payment rows; good read carries ۱۲،۰۰۰،۰۰۰ matching the words
  const bad = [
    '۱۷۰ : محسن شمار ه Syl ؟ افز pp',
    'مبلغ به عدد : ۱۲:۵۰:۰۰ ریال به حروف : دوازده میلیون ریال از آقای/خانم : مشتری اول',
    'جمع به حروف : دوازده میلیون ریال',
  ].join('\n');
  const good = [
    'شماره : ۱۷۰ نرم افزاری محسن',
    'مبلغ به عدد : ۱۲،۰۰۰،۰۰۰ ریال به حروف : دوازده میلیون ریال از آقای/خانم : مشتری اول',
    'چک ۱۲۳۴۵۶ — ۵،۰۰۰،۰۰۰ ریال',
    'ATM — ۷،۰۰۰،۰۰۰ ریال',
    'جمع به حروف : دوازده میلیون ریال',
  ].join('\n');
  assert.ok(P.transcriptScore(good) > P.transcriptScore(bad) + 1,
    `good=${P.transcriptScore(good)} must beat bad=${P.transcriptScore(bad)}`);
  assert.equal(P.transcriptScore(''), -1);
});

test('collectIdentifiers: labelled numbers are IDs; مبلغ lines are not', () => {
  const text = [
    'شماره چک/نوع : ۱۲۳۴۵۶',
    'شماره حساب/شماره مرجع : ۹۸۷۶۵',
    'شماره مرجع : ۹۹۸۸۷۶۶',
    'شماره ترمینال : ۹۰۹۲۰',
    'به کارت شماره ۳۹۹۵-****-****-****',
    'شماره بازیابی: ۱۳۰۰۷۲۰۶۴۹۷۱',
    'تاریخ : ۱۳۹۵/۰۸/۱۳',
    'مبلغ ۲۰,۰۰۰,۰۰۰ ریال',
  ].join('\n');
  const ids = P.collectIdentifiers(text);
  assert.equal(ids.byKey.cheque, '123456');
  assert.equal(ids.byKey.account, '98765');
  assert.equal(ids.byKey.terminal, '90920');
  assert.ok(ids.all.has('9988766'));
  assert.ok(ids.all.has('130072064971'));
  assert.ok(ids.all.has('13950813'));            // the date, digits-only
  assert.ok(!ids.all.has('20000000'));           // the amount must NOT be an id
});

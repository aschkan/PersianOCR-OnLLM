import React from 'react';
import { useT } from '../i18n/LangContext';
import { fmtNum } from './ui';

/** Human currency label next to amounts: IRR → ریال, IRT → تومان (codes in EN UI). */
function curLabel(currency, lang) {
  if (!currency) return '';
  if (currency === 'IRR') return lang === 'fa' ? 'ریال' : 'IRR';
  if (currency === 'IRT') return lang === 'fa' ? 'تومان' : 'IRT';
  return String(currency);
}

/**
 * Renders the structured invoice: receipt-relevant data ONLY. The extraction
 * JSON also carries verification internals (checks, confidence, raw text…) —
 * those stay out of this card; the JSON download has everything.
 */
export default function StructuredView({ data }) {
  const { T, lang } = useT();
  if (!data) return null;

  const cur = curLabel(data.currency, lang);
  const money = (v) => (v == null ? '—' : `${fmtNum(v)}${cur ? ` ${cur}` : ''}`);

  const ids = data.identifiers || {};
  const fields = [
    [T.merchant, data.merchant],
    [T.branch, data.branch],
    [T.date, data.date],
    [T.time, data.time],
    [T.invoiceNo, data.invoiceNumber],
    [T.payment, data.paymentMethod],
    [T.phone, data.phone],
    [T.address, data.address],
    [T.amountWords, data.amountInWords],
    [T.idCheque, ids.cheque],
    [T.idAccount, ids.account],
    [T.idReference, ids.reference],
    [T.idTerminal, ids.terminal],
    [T.idCard, ids.card],
    [T.idSerial, ids.serial],
  ].filter(([, v]) => v != null && v !== '');

  // Only rows that actually say something — no empty placeholder lines.
  const items = (Array.isArray(data.items) ? data.items : []).filter(
    (it) => (it.name && it.name.trim() && it.name.trim() !== '—') ||
      it.qty != null || it.unitPrice != null || it.total != null
  );
  const totals = [
    [T.subtotal, data.subtotal],
    [T.discount, data.discount],
    [T.tax, data.tax],
  ].filter(([, v]) => v != null);

  return (
    <div>
      {fields.length > 0 && (
        <div className="kv" style={{ marginBottom: '1rem' }}>
          {fields.map(([k, v]) => (
            <div key={k}><div className="k">{k}</div><div className="v">{String(v)}</div></div>
          ))}
        </div>
      )}

      {items.length > 0 && (
        <div style={{ overflowX: 'auto' }}>
          <table className="items-table">
            <thead>
              <tr>
                <th>{T.item}</th>
                <th className="num">{T.qty}</th>
                <th className="num">{T.unitPrice}</th>
                <th className="num">{T.lineTotal}</th>
              </tr>
            </thead>
            <tbody>
              {items.map((it, i) => (
                <tr key={i}>
                  <td>{it.name || '—'}</td>
                  <td className="num">{fmtNum(it.qty)}</td>
                  <td className="num">{fmtNum(it.unitPrice)}</td>
                  <td className="num">{fmtNum(it.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* totals render with or without an items table (transfers have no items) */}
      {(totals.length > 0 || data.total != null) && (
        <div className="kv" style={{ marginTop: items.length ? '.75rem' : 0 }}>
          {totals.map(([k, v]) => (
            <div key={k}><div className="k">{k}</div><div className="v">{money(v)}</div></div>
          ))}
          {data.total != null && (
            <div>
              <div className="k">{T.total}</div>
              <div className="v" style={{ fontWeight: 700 }}>{money(data.total)}</div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

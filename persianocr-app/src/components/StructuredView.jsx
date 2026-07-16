import React from 'react';
import { useT } from '../i18n/LangContext';
import { fmtNum } from './ui';

/** Renders the extracted structured invoice: header fields + an items table. */
export default function StructuredView({ data }) {
  const { T } = useT();
  if (!data) return null;
  const items = Array.isArray(data.items) ? data.items : [];
  const cur = data.currency ? ` ${data.currency}` : '';

  const fields = [
    [T.merchant, data.merchant],
    [T.date, data.date],
    [T.time, data.time],
    [T.invoiceNo, data.invoiceNumber],
    [T.phone, data.phone],
    [T.payment, data.paymentMethod],
    [T.address, data.address],
  ].filter(([, v]) => v != null && v !== '');

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
            <tfoot>
              {data.subtotal != null && <tr><td colSpan={3}>{T.subtotal}</td><td className="num">{fmtNum(data.subtotal)}{cur}</td></tr>}
              {data.discount != null && <tr><td colSpan={3}>{T.discount}</td><td className="num">{fmtNum(data.discount)}{cur}</td></tr>}
              {data.tax != null && <tr><td colSpan={3}>{T.tax}</td><td className="num">{fmtNum(data.tax)}{cur}</td></tr>}
              {data.total != null && <tr><td colSpan={3}>{T.total}</td><td className="num">{fmtNum(data.total)}{cur}</td></tr>}
            </tfoot>
          </table>
        </div>
      )}
    </div>
  );
}

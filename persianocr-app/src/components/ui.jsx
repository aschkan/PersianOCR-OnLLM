import React, { useEffect, useState } from 'react';

export function Spinner() { return <div className="center"><div className="spinner" /></div>; }
export function InlineSpinner() { return <span className="spinner" style={{ width: 18, height: 18, borderWidth: 2, display: 'inline-block', verticalAlign: 'middle' }} />; }
export function Empty({ children }) { return <div className="empty">{children}</div>; }
export function ErrorBox({ children }) { return children ? <div className="err">{children}</div> : null; }

/** A tiny transient toast. Returns [node, show]. */
export function useToast() {
  const [msg, setMsg] = useState('');
  useEffect(() => { if (!msg) return; const t = setTimeout(() => setMsg(''), 2400); return () => clearTimeout(t); }, [msg]);
  const node = msg ? <div className="snackbar">{msg}</div> : null;
  return [node, setMsg];
}

/** Status pill for a receipt. */
export function StatusTag({ status, T }) {
  if (status === 'done') return <span className="tag ok">{T.done}</span>;
  if (status === 'error') return <span className="tag err">{T.error}</span>;
  return <span className="tag proc">{T.processing}</span>;
}

export function fmtDate(d, lang) {
  if (!d) return '—';
  try { return new Date(d).toLocaleString(lang === 'fa' ? 'fa-IR' : 'en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); }
  catch { return String(d).slice(0, 16); }
}

export function fmtBytes(n) {
  if (!n) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** Format a possibly-Persian-digit number nicely (grouping) without corrupting it. */
export function fmtNum(v) {
  if (v == null || v === '') return '';
  const n = Number(v);
  if (Number.isFinite(n)) return n.toLocaleString('en-US');
  return String(v);
}

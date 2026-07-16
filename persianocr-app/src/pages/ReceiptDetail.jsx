import React, { useEffect, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { ArrowRight, ArrowLeft, Trash2 } from 'lucide-react';
import { useT } from '../i18n/LangContext';
import { api } from '../api/client';
import { Spinner, ErrorBox, StatusTag, useToast, fmtDate } from '../components/ui';
import ResultPanel from '../components/ResultPanel';

export default function ReceiptDetail() {
  const { id } = useParams();
  const { T, lang, dir } = useT();
  const nav = useNavigate();
  const [toast, showToast] = useToast();
  const [doc, setDoc] = useState(null);
  const [error, setError] = useState('');

  const load = async () => {
    try { const r = await api.get(id); setDoc(r.receipt); }
    catch (e) { setError(e.message); setDoc(false); }
  };
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const saveText = async (text) => { await api.updateText(id, text); setDoc((d) => ({ ...d, text })); };
  const reprocess = async () => { const r = await api.reprocess(id); setDoc((d) => ({ ...d, text: r.receipt.text, status: 'done' })); };
  const del = async () => {
    if (!window.confirm(T.confirmDelete)) return;
    try { await api.remove(id); nav('/history'); } catch (e) { showToast(e.message); }
  };

  if (doc === null) return <Spinner />;
  if (!doc) return <div><ErrorBox>{error || 'Not found'}</ErrorBox><Link className="btn ghost" to="/history">{T.navHistory}</Link></div>;

  const Back = dir === 'rtl' ? ArrowRight : ArrowLeft;

  return (
    <div>
      <div className="topbar">
        <button className="ghost icon" onClick={() => nav('/history')} aria-label="back"><Back size={18} /></button>
        <h1 style={{ fontSize: '1.4rem' }}>{doc.structured?.merchant || T.original}</h1>
        <StatusTag status={doc.status} T={T} />
        <span className="spacer" />
        <button className="danger small" onClick={del}><Trash2 size={15} /> {T.delete}</button>
      </div>
      <div className="small muted" style={{ marginBottom: '1rem' }}>{fmtDate(doc.createdAt, lang)} · {doc.model}{doc.durationMs ? ` · ${(doc.durationMs / 1000).toFixed(1)}${T.seconds}` : ''}</div>

      <ErrorBox>{doc.status === 'error' ? doc.error : ''}</ErrorBox>

      <div className="grid2">
        <div className="card glass">
          <h3>{T.original}</h3>
          <div className="preview-wrap">
            <img src={api.imageUrl(id)} alt="receipt" />
          </div>
        </div>

        <ResultPanel
          text={doc.text}
          receiptId={id}
          structured={doc.structured}
          onStructured={(s) => setDoc((d) => ({ ...d, structured: s }))}
          onSaveText={saveText}
          onReprocess={reprocess}
          onToast={showToast}
        />
      </div>
      {toast}
    </div>
  );
}

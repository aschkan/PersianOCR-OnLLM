import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Trash2, ScanText } from 'lucide-react';
import { useT } from '../i18n/LangContext';
import { api } from '../api/client';
import { Spinner, Empty, ErrorBox, StatusTag, useToast, fmtDate } from '../components/ui';

export default function History() {
  const { T, lang } = useT();
  const nav = useNavigate();
  const [toast, showToast] = useToast();
  const [items, setItems] = useState(null);
  const [error, setError] = useState('');

  const load = async () => {
    try { const r = await api.list('?limit=60'); setItems(r.receipts); }
    catch (e) { setError(e.message); setItems([]); }
  };
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const del = async (e, id) => {
    e.stopPropagation();
    if (!window.confirm(T.confirmDelete)) return;
    try { await api.remove(id); setItems((xs) => xs.filter((x) => x._id !== id)); showToast(T.delete); }
    catch (err) { showToast(err.message); }
  };

  if (items === null) return <Spinner />;

  return (
    <div>
      <div className="topbar"><h1>{T.historyTitle}</h1></div>
      <ErrorBox>{error}</ErrorBox>

      {items.length === 0 ? (
        <Empty><ScanText size={32} style={{ opacity: 0.4, marginBottom: 10 }} /><div>{T.historyEmpty}</div></Empty>
      ) : (
        <div className="hist-grid">
          {items.map((r) => (
            <div key={r._id} className="hist-card" onClick={() => nav(`/receipt/${r._id}`)}>
              <img className="hist-thumb" src={api.imageUrl(r._id)} alt="receipt" loading="lazy" />
              <div className="hist-body">
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <StatusTag status={r.status} T={T} />
                  <button className="danger icon small" style={{ width: 32, height: 32 }} onClick={(e) => del(e, r._id)} aria-label={T.delete}><Trash2 size={15} /></button>
                </div>
                <div className="small muted" style={{ marginTop: '.4rem' }}>{fmtDate(r.createdAt, lang)}</div>
                {r.structured?.merchant && <div className="small" style={{ fontWeight: 600, marginTop: 2 }}>{r.structured.merchant}</div>}
                {r.structured?.total != null && <div className="small muted">{Number(r.structured.total).toLocaleString('en-US')} {r.structured.currency || ''}</div>}
              </div>
            </div>
          ))}
        </div>
      )}
      {toast}
    </div>
  );
}

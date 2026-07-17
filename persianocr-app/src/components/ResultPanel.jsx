import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Copy, Check, Download, Pencil, Save, X, FileJson, Braces, Code2, RefreshCw, Eye, Maximize2 } from 'lucide-react';
import { useT } from '../i18n/LangContext';
import { api, copyText } from '../api/client';
import { InlineSpinner } from './ui';
import Markdown from './Markdown';
import StructuredView from './StructuredView';

/**
 * ResultPanel — the OCR output surface. Shows the transcription (formatted or
 * raw), copy/download/edit actions, structured (JSON) extraction, and re-run.
 * Used both live on the Home page (while streaming) and on the detail page.
 */
export default function ResultPanel({
  text, streaming = false, receiptId = null,
  structured = null, structuring = false, onStructured, onSaveText, onReprocess,
  showOpenDetail = false, onToast,
}) {
  const { T } = useT();
  const [raw, setRaw] = useState(false);
  const [copied, setCopied] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(text || '');
  const [busy, setBusy] = useState('');

  useEffect(() => { if (!editing) setDraft(text || ''); }, [text, editing]);

  const doCopy = async () => {
    if (await copyText(text)) { setCopied(true); setTimeout(() => setCopied(false), 1600); onToast && onToast(T.copied); }
  };

  const doExtract = async () => {
    if (!receiptId) return;
    setBusy('extract');
    try { const r = await api.structure(receiptId); onStructured && onStructured(r.structured); }
    catch (e) { onToast && onToast(e.message); }
    finally { setBusy(''); }
  };

  const doReprocess = async () => {
    if (!onReprocess) return;
    setBusy('reprocess');
    try { await onReprocess(); } catch (e) { onToast && onToast(e.message); } finally { setBusy(''); }
  };

  const saveEdit = async () => {
    setBusy('save');
    try { await onSaveText(draft); setEditing(false); onToast && onToast(T.save); }
    catch (e) { onToast && onToast(e.message); }
    finally { setBusy(''); }
  };

  return (
    <div className="card glass">
      <div className="row" style={{ marginBottom: '.5rem' }}>
        <h3 style={{ margin: 0 }}>{T.resultTitle}</h3>
        <span className="spacer" />
        {streaming && <span className="tag proc">{T.processing}</span>}

        {!streaming && text ? (
          <div className="row" style={{ gap: '.4rem' }}>
            <button className="ghost small" onClick={() => setRaw((v) => !v)} title={raw ? T.viewFormatted : T.viewRaw}>
              {raw ? <><Eye size={15} /> {T.viewFormatted}</> : <><Code2 size={15} /> {T.viewRaw}</>}
            </button>
            <button className="ghost small" onClick={doCopy}>{copied ? <Check size={15} /> : <Copy size={15} />} {copied ? T.copied : T.copy}</button>
          </div>
        ) : null}
      </div>

      {/* transcription body */}
      {editing ? (
        <textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={16} style={{ fontFamily: 'monospace' }} />
      ) : text ? (
        raw ? <pre className="rawbox">{text}</pre> : <div className={streaming ? 'caret' : ''}><Markdown>{text}</Markdown></div>
      ) : (
        <div className="empty">{streaming ? T.processing : T.waiting}</div>
      )}

      {/* actions */}
      {!streaming && text && (
        <div className="row" style={{ marginTop: '1rem', gap: '.4rem' }}>
          {onSaveText && !editing && <button className="ghost small" onClick={() => setEditing(true)}><Pencil size={15} /> {T.edit}</button>}
          {onSaveText && editing && (
            <>
              <button className="primary small" onClick={saveEdit} disabled={busy === 'save'}>{busy === 'save' ? <InlineSpinner /> : <Save size={15} />} {T.save}</button>
              <button className="ghost small" onClick={() => { setEditing(false); setDraft(text); }}><X size={15} /> {T.cancel}</button>
            </>
          )}

          {receiptId && !editing && (
            <>
              <button className="ghost small" onClick={doExtract} disabled={busy === 'extract'}>
                {busy === 'extract' ? <InlineSpinner /> : <Braces size={15} />} {busy === 'extract' ? T.extracting : T.extract}
              </button>
              <a className="btn ghost small" href={api.exportUrl(receiptId, 'txt')}><Download size={15} /> {T.download} TXT</a>
              <a className="btn ghost small" href={api.exportUrl(receiptId, 'md')}><Download size={15} /> MD</a>
              <a className="btn ghost small" href={api.exportUrl(receiptId, 'json')}><FileJson size={15} /> JSON</a>
              {onReprocess && <button className="ghost small" onClick={doReprocess} disabled={busy === 'reprocess'}>{busy === 'reprocess' ? <InlineSpinner /> : <RefreshCw size={15} />} {T.reprocess}</button>}
              {showOpenDetail && <Link className="btn small" to={`/receipt/${receiptId}`}><Maximize2 size={15} /> {T.openDetail}</Link>}
            </>
          )}
        </div>
      )}

      {/* structured extraction (auto-run after transcription; nicer table) */}
      {(structured || structuring) && (
        <div style={{ marginTop: '1.25rem', borderTop: '1px solid rgb(var(--line))', paddingTop: '1rem' }}>
          <div className="row" style={{ marginBottom: '.4rem' }}>
            <h3 style={{ margin: 0 }}>{T.structuredTitle}</h3>
            {structuring && <span className="tag proc"><InlineSpinner /> {T.extracting}</span>}
          </div>
          {structured ? <StructuredView data={structured} /> : <div className="muted small">{T.extracting}</div>}
        </div>
      )}
    </div>
  );
}

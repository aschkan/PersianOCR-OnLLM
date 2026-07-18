import React, { useEffect, useRef, useState } from 'react';
import { Copy, Check, Download, Pencil, Save, X, FileJson, Code2, RefreshCw, Eye } from 'lucide-react';
import { useT } from '../i18n/LangContext';
import { api, copyText } from '../api/client';
import { InlineSpinner } from './ui';
import Markdown from './Markdown';
import StructuredView from './StructuredView';

/**
 * ResultPanel — the OCR output surface. Shows the transcription (formatted or
 * raw) with copy/download/edit actions, and runs the structured (JSON)
 * extraction AUTOMATICALLY once the text is in — no separate button. A 2-step
 * progress bar tells the user the invoice data is still coming (1/2 → 2/2).
 * Used both live on the Home page (while streaming) and on the detail page.
 */
export default function ResultPanel({
  text, streaming = false, receiptId = null,
  structured = null, structuring = false, onStructured, onSaveText, onReprocess,
  onToast,
}) {
  const { T } = useT();
  const [raw, setRaw] = useState(false);
  const [copied, setCopied] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(text || '');
  const [busy, setBusy] = useState('');
  const autoRef = useRef(''); // receipt id whose auto-extraction already ran

  useEffect(() => { if (!editing) setDraft(text || ''); }, [text, editing]);

  const extracting = structuring || busy === 'extract';

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

  // Structured extraction runs by itself as soon as the transcription is done —
  // one automatic attempt per receipt (re-armed by a re-run; retry stays manual).
  useEffect(() => {
    if (streaming || !text || !receiptId || structured || extracting) return;
    if (autoRef.current === receiptId) return;
    autoRef.current = receiptId;
    doExtract();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streaming, text, receiptId, structured]);

  const doReprocess = async () => {
    if (!onReprocess) return;
    setBusy('reprocess');
    try {
      onStructured && onStructured(null);  // stale invoice data goes away…
      await onReprocess();
      autoRef.current = '';                // …and re-extracts from the new text
    } catch (e) { onToast && onToast(e.message); }
    finally { setBusy(''); }
  };

  const saveEdit = async () => {
    setBusy('save');
    try { await onSaveText(draft); setEditing(false); onToast && onToast(T.save); }
    catch (e) { onToast && onToast(e.message); }
    finally { setBusy(''); }
  };

  // 2-step progress: streaming text = step 1 running; extraction = step 2.
  const showBar = streaming || extracting || busy === 'reprocess';

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

      {showBar && (
        <div style={{ margin: '0 0 .9rem' }}>
          <div className="progressbar"><i style={{ width: streaming || busy === 'reprocess' ? '20%' : '60%' }} /></div>
          <div className="small muted" style={{ marginTop: '.3rem' }}>
            {streaming || busy === 'reprocess' ? T.progStep1 : T.progStep2}
          </div>
        </div>
      )}

      {/* transcription body */}
      {editing ? (
        <textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={16} style={{ fontFamily: 'monospace' }} />
      ) : text ? (
        raw ? <pre className="rawbox">{text}</pre> : <div className={streaming ? 'caret' : ''}><Markdown>{text}</Markdown></div>
      ) : (
        <div className="empty">{streaming ? T.processing : T.waiting}</div>
      )}

      {/* actions — one JSON button (the download); extraction is automatic */}
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
              <a className="btn ghost small" href={api.exportUrl(receiptId, 'txt')}><Download size={15} /> {T.download} TXT</a>
              <a className="btn ghost small" href={api.exportUrl(receiptId, 'md')}><Download size={15} /> MD</a>
              <a className="btn ghost small" href={api.exportUrl(receiptId, 'json')}><FileJson size={15} /> JSON</a>
              {onReprocess && <button className="ghost small" onClick={doReprocess} disabled={busy === 'reprocess'}>{busy === 'reprocess' ? <InlineSpinner /> : <RefreshCw size={15} />} {T.reprocess}</button>}
            </>
          )}
        </div>
      )}

      {/* structured invoice data (runs automatically; retry only on failure) */}
      {receiptId && !streaming && text && (
        <div style={{ marginTop: '1.25rem', borderTop: '1px solid rgb(var(--line))', paddingTop: '1rem' }}>
          <div className="row" style={{ marginBottom: '.4rem' }}>
            <h3 style={{ margin: 0 }}>{T.structuredTitle}</h3>
            {extracting
              ? <span className="tag proc"><InlineSpinner /> {T.extracting}</span>
              : structured ? <span className="tag ok">{T.progDone}</span> : null}
          </div>
          {structured
            ? <StructuredView data={structured} />
            : extracting
              ? <div className="muted small">{T.extracting}</div>
              : <button className="ghost small" onClick={doExtract}><RefreshCw size={15} /> {T.retry}</button>}
        </div>
      )}
    </div>
  );
}

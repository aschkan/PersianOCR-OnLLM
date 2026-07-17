import React, { useEffect, useRef, useState } from 'react';
import { ScanText, RotateCcw, Sparkles } from 'lucide-react';
import { useT } from '../i18n/LangContext';
import { api } from '../api/client';
import Dropzone from '../components/Dropzone';
import ResultPanel from '../components/ResultPanel';
import { ErrorBox, useToast, fmtBytes } from '../components/ui';

export default function Home() {
  const { T } = useT();
  const [toast, showToast] = useToast();

  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState('');
  const [note, setNote] = useState('');

  const [streaming, setStreaming] = useState(false);
  const [text, setText] = useState('');
  const [receiptId, setReceiptId] = useState(null);
  const [structured, setStructured] = useState(null);
  const [structuring, setStructuring] = useState(false);
  const [error, setError] = useState('');
  const startedRef = useRef(false);

  // Build/tear-down the object URL for the local preview.
  useEffect(() => {
    if (!file) { setPreview(''); return; }
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  const chooseFile = (f) => {
    setFile(f); setText(''); setReceiptId(null); setStructured(null); setError('');
    startedRef.current = false;
  };

  const reset = () => {
    setFile(null); setNote(''); setText(''); setReceiptId(null);
    setStructured(null); setStructuring(false); setError(''); setStreaming(false); startedRef.current = false;
  };

  const start = async () => {
    if (!file || streaming) return;
    setStreaming(true); setError(''); setText(''); setStructured(null); startedRef.current = true;
    let id;
    try {
      ({ id } = await api.transcribeStream(file, note, (full) => setText(full)));
      setReceiptId(id);
    } catch (e) {
      setError(e.message || T.ocrFailed);
    } finally {
      setStreaming(false);
    }
    // Auto-extract the structured invoice — its table is cleaner than the raw
    // transcription, so we surface it without making the user click.
    if (id) {
      setStructuring(true);
      try { const r = await api.structure(id); setStructured(r.structured); } catch { /* keep the transcription */ } finally { setStructuring(false); }
    }
  };

  const saveText = async (newText) => {
    if (!receiptId) return;
    await api.updateText(receiptId, newText);
    setText(newText);
  };

  const reprocess = async () => {
    if (!receiptId) return;
    setStreaming(true); setStructured(null);
    try { const r = await api.reprocess(receiptId); setText(r.receipt.text || ''); }
    finally { setStreaming(false); }
  };

  return (
    <div>
      <div className="hero">
        <span className="eyebrow"><Sparkles size={14} /> {T.heroEyebrow}</span>
        <h1><span className="grad">{T.heroTitle}</span></h1>
        <p>{T.heroSub}</p>
      </div>

      {!file ? (
        <Dropzone onFile={chooseFile} />
      ) : (
        <div className="grid2">
          {/* left: image + controls */}
          <div>
            <div className="card glass" style={{ marginBottom: '1rem' }}>
              <div className="preview-wrap">
                <img src={preview} alt="receipt preview" />
                <span className="preview-badge">{file.name ? file.name.slice(0, 22) : 'image'} · {fmtBytes(file.size)}</span>
              </div>

              {!startedRef.current && (
                <>
                  <label htmlFor="note">{T.noteLabel}</label>
                  <input id="note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="…" />
                </>
              )}

              <div className="row" style={{ marginTop: '.85rem' }}>
                {!startedRef.current ? (
                  <button className="primary" onClick={start} disabled={streaming}><Sparkles size={16} /> {T.startOcr}</button>
                ) : null}
                <button className="ghost" onClick={reset}><RotateCcw size={16} /> {T.change}</button>
              </div>
              <ErrorBox>{error}</ErrorBox>
            </div>
          </div>

          {/* right: result */}
          <div>
            {startedRef.current || streaming ? (
              <ResultPanel
                text={text}
                streaming={streaming}
                receiptId={receiptId}
                structured={structured}
                structuring={structuring}
                onStructured={setStructured}
                onSaveText={receiptId ? saveText : null}
                onReprocess={receiptId ? reprocess : null}
                showOpenDetail={!!receiptId}
                onToast={showToast}
              />
            ) : (
              <div className="card glass center" style={{ minHeight: 220 }}>
                <div className="empty"><ScanText size={30} style={{ opacity: 0.4, marginBottom: 8 }} /><div>{T.startOcr}</div></div>
              </div>
            )}
          </div>
        </div>
      )}

      {toast}
    </div>
  );
}

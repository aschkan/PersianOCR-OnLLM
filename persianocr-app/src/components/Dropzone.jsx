import React, { useCallback, useEffect, useRef, useState } from 'react';
import { UploadCloud, Camera, ImageUp } from 'lucide-react';
import { useT } from '../i18n/LangContext';

/**
 * Dropzone — pick a receipt image by drag-and-drop, click, camera, or paste.
 * Calls onFile(File) with the chosen image. `paste` is wired globally so the
 * user can just Ctrl/Cmd-V a screenshot.
 */
export default function Dropzone({ onFile }) {
  const { T } = useT();
  const [drag, setDrag] = useState(false);
  const fileRef = useRef(null);
  const camRef = useRef(null);

  const pick = useCallback((f) => { if (f && /^image\//.test(f.type)) onFile(f); }, [onFile]);

  useEffect(() => {
    const onPaste = (e) => {
      const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith('image/'));
      if (item) { const f = item.getAsFile(); if (f) pick(f); }
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [pick]);

  const onDrop = (e) => {
    e.preventDefault(); setDrag(false);
    const f = e.dataTransfer?.files?.[0];
    if (f) pick(f);
  };

  return (
    <div>
      <div
        className={`dropzone ${drag ? 'drag' : ''}`}
        onClick={() => fileRef.current?.click()}
        onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
        onDragLeave={() => setDrag(false)}
        onDrop={onDrop}
        role="button" tabIndex={0}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') fileRef.current?.click(); }}
      >
        <div className="dz-icon"><UploadCloud size={30} /></div>
        <div className="dz-title">{T.dropTitle}</div>
        <div className="dz-hint">{T.dropHint}</div>
        <div className="row" style={{ justifyContent: 'center', marginTop: '.4rem' }} onClick={(e) => e.stopPropagation()}>
          <button className="primary" onClick={() => fileRef.current?.click()}><ImageUp size={16} /> {T.chooseFile}</button>
          <button className="ghost" onClick={() => camRef.current?.click()}><Camera size={16} /> {T.takePhoto}</button>
        </div>
      </div>

      <input ref={fileRef} type="file" accept="image/*" hidden
        onChange={(e) => { pick(e.target.files?.[0]); e.target.value = ''; }} />
      {/* `capture` opens the rear camera on mobile */}
      <input ref={camRef} type="file" accept="image/*" capture="environment" hidden
        onChange={(e) => { pick(e.target.files?.[0]); e.target.value = ''; }} />
    </div>
  );
}

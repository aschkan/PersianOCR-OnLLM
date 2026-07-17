import React, { useEffect, useState } from 'react';
import { RefreshCw, Server, Cpu, Globe, Timer, Layers, ScanText } from 'lucide-react';
import { useT } from '../i18n/LangContext';
import { api } from '../api/client';
import { InlineSpinner } from '../components/ui';
import ThemeSwitcher from '../components/ThemeSwitcher';

export default function Settings() {
  const { T, lang, setLang } = useT();
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);

  const check = async () => {
    setLoading(true);
    try { setStatus(await api.ocrStatus()); } catch (e) { setStatus({ ok: false, error: e.message }); }
    finally { setLoading(false); }
  };
  useEffect(() => { check(); }, []);

  return (
    <div>
      <div className="topbar"><h1>{T.settingsTitle}</h1></div>

      {/* model status */}
      <div className="card glass">
        <div className="row">
          <h3 style={{ margin: 0 }}><Server size={18} style={{ verticalAlign: '-3px', marginInlineEnd: 6 }} />{T.modelStatus}</h3>
          <span className="spacer" />
          {loading ? <span className="tag proc">{T.processing}</span>
            : status?.ok ? <span className="tag ok">{T.online}</span>
            : <span className="tag err">{T.offline}</span>}
          <button className="ghost small" onClick={check} disabled={loading}>{loading ? <InlineSpinner /> : <RefreshCw size={15} />} {T.checkAgain}</button>
        </div>

        <div className="kv" style={{ marginTop: '.8rem' }}>
          <div><div className="k"><Cpu size={13} style={{ verticalAlign: '-2px' }} /> {T.model}</div><div className="v">{status?.config?.model || status?.model || '—'}</div></div>
          <div><div className="k"><Globe size={13} style={{ verticalAlign: '-2px' }} /> {T.endpoint}</div><div className="v" style={{ wordBreak: 'break-all', fontSize: '.85rem' }}>{status?.config?.url || status?.url || '—'}</div></div>
          <div><div className="k"><Timer size={13} style={{ verticalAlign: '-2px' }} /> {T.latency}</div><div className="v">{status?.ms != null ? `${status.ms} ms` : '—'}</div></div>
          <div><div className="k"><Layers size={13} style={{ verticalAlign: '-2px' }} /> {T.passes}</div><div className="v">{status?.config?.passes ?? '—'}</div></div>
          <div>
            <div className="k"><ScanText size={13} style={{ verticalAlign: '-2px' }} /> {T.refOcr}</div>
            <div className="v">{status?.config?.tesseract?.available
              ? <span className="tag ok">{status.config.tesseract.lang || 'on'}</span>
              : <span className="tag warn">{T.refOcrOff}</span>}</div>
          </div>
        </div>
        {status && !status.ok && status.error && <div className="err" style={{ marginTop: '.7rem' }}>{status.error}</div>}
      </div>

      {/* appearance */}
      <div className="card glass">
        <h3>{T.theme}</h3>
        <ThemeSwitcher />
        <label>{T.language}</label>
        <div className="row">
          <button className={lang === 'fa' ? 'primary small' : 'ghost small'} onClick={() => setLang('fa')}>فارسی</button>
          <button className={lang === 'en' ? 'primary small' : 'ghost small'} onClick={() => setLang('en')}>English</button>
        </div>
      </div>

      {/* about */}
      <div className="card glass">
        <h3>{T.about}</h3>
        <p className="muted" style={{ margin: 0 }}>{T.aboutText}</p>
      </div>
    </div>
  );
}

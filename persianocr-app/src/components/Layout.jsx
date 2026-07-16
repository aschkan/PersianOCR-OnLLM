import React, { useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { ScanText, History, Settings as SettingsIcon, Menu } from 'lucide-react';
import { useT } from '../i18n/LangContext';
import ThemeSwitcher from './ThemeSwitcher';

export default function Layout({ children }) {
  const { T, toggle, lang } = useT();
  const [open, setOpen] = useState(false);
  const loc = useLocation();

  // [path, label, lucide icon]
  const items = [
    ['/', T.navUpload, ScanText],
    ['/history', T.navHistory, History],
    ['/settings', T.navSettings, SettingsIcon],
  ];
  const close = () => setOpen(false);

  return (
    <div className="app">
      <div className="mobile-top">
        <button className="ghost menu-btn icon" onClick={() => setOpen((o) => !o)} aria-label="menu"><Menu size={20} /></button>
        <b className="brand-inline"><ScanText size={18} /> {T.appName}</b>
        <span className="spacer" />
        <button className="ghost icon" onClick={toggle}>{lang === 'fa' ? 'EN' : 'فا'}</button>
      </div>

      {open && <div className="scrim" onClick={close} />}

      <nav className={`nav ${open ? 'open' : ''}`}>
        <div className="brand"><span className="logo"><ScanText size={18} /></span> {T.appName}</div>
        {items.map(([to, label, Icon]) => (
          <NavLink key={to} to={to} end={to === '/'} onClick={close}
            className={({ isActive }) => (isActive ? 'active' : '')}>
            <span className="ic"><Icon size={18} /></span><span>{label}</span>
          </NavLink>
        ))}
        <div className="spacer" />
        <ThemeSwitcher />
        <button className="ghost" onClick={toggle} style={{ marginBottom: '.4rem' }}>
          {lang === 'fa' ? 'English' : 'فارسی'}
        </button>
        <div className="small muted" style={{ padding: '0 .3rem' }}>{T.tagline}</div>
      </nav>

      <main className="main">
        <AnimatePresence mode="wait">
          <motion.div key={loc.pathname}
            initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.18, ease: 'easeOut' }}>
            {children}
          </motion.div>
        </AnimatePresence>
      </main>

      {/* mobile bottom tab bar */}
      <nav className="tabbar">
        {items.map(([to, label, Icon]) => (
          <NavLink key={to} to={to} end={to === '/'}
            className={({ isActive }) => (isActive ? 'active' : '')}>
            <span className="ic"><Icon size={20} /></span>
            <span className="lbl">{label}</span>
          </NavLink>
        ))}
      </nav>
    </div>
  );
}

import React from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { ScanLine, History, Settings as SettingsIcon, Languages } from 'lucide-react';
import { useT } from '../i18n/LangContext';
import ThemeSwitcher from './ThemeSwitcher';

export default function Layout({ children }) {
  const { T, toggle } = useT();
  const loc = useLocation();

  const items = [
    ['/', T.navUpload, ScanLine],
    ['/history', T.navHistory, History],
    ['/settings', T.navSettings, SettingsIcon],
  ];

  return (
    <div className="app">
      <header className="nav">
        <NavLink to="/" className="brand" style={{ color: 'inherit' }}>
          <span className="logo"><ScanLine size={20} /></span>
          {T.appName}
        </NavLink>
        <div className="links">
          {items.map(([to, label, Icon]) => (
            <NavLink key={to} to={to} end={to === '/'} className={({ isActive }) => (isActive ? 'active' : '')}>
              <span className="ic"><Icon size={17} /></span><span>{label}</span>
            </NavLink>
          ))}
        </div>
        <span className="spacer" />
        <button className="icon-btn" onClick={toggle} title="Language" aria-label="language">
          <Languages size={18} />
        </button>
        <ThemeSwitcher />
      </header>

      <main className="main">
        <AnimatePresence mode="wait">
          <motion.div key={loc.pathname}
            initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.2, ease: 'easeOut' }}>
            {children}
          </motion.div>
        </AnimatePresence>
      </main>

      {/* mobile bottom tab bar */}
      <nav className="tabbar">
        {items.map(([to, label, Icon]) => (
          <NavLink key={to} to={to} end={to === '/'} className={({ isActive }) => (isActive ? 'active' : '')}>
            <Icon size={20} />
            <span>{label}</span>
          </NavLink>
        ))}
      </nav>
    </div>
  );
}

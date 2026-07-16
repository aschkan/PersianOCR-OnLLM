import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import STRINGS from './strings';

const LangContext = createContext(null);
const KEY = 'pocr_lang';

export function LangProvider({ children }) {
  const [lang, setLang] = useState(() => localStorage.getItem(KEY) || 'fa');

  useEffect(() => {
    localStorage.setItem(KEY, lang);
    const s = STRINGS[lang] || STRINGS.fa;
    document.documentElement.lang = s.lang;
    document.documentElement.dir = s.dir;
  }, [lang]);

  const value = useMemo(() => {
    const T = STRINGS[lang] || STRINGS.fa;
    return { T, lang, dir: T.dir, setLang, toggle: () => setLang((l) => (l === 'fa' ? 'en' : 'fa')) };
  }, [lang]);

  return <LangContext.Provider value={value}>{children}</LangContext.Provider>;
}

export function useT() {
  const ctx = useContext(LangContext);
  if (!ctx) throw new Error('useT must be used within LangProvider');
  return ctx;
}

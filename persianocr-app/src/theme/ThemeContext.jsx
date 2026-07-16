import React, { createContext, useContext, useEffect, useState } from 'react';

// Switchable colour palettes. `swatch` is the little preview gradient.
export const THEMES = [
  { id: 'cyber', name: 'Cyber', swatch: 'linear-gradient(135deg,#22d3ee,#a855f7)' },
  { id: 'aurora', name: 'Aurora', swatch: 'linear-gradient(135deg,#2dd4bf,#22c55e)' },
  { id: 'sunset', name: 'Sunset', swatch: 'linear-gradient(135deg,#fb7185,#f59e0b)' },
  { id: 'royal', name: 'Royal', swatch: 'linear-gradient(135deg,#d4af37,#6d8bff)' },
  { id: 'light', name: 'Light', swatch: 'linear-gradient(135deg,#0ea5e9,#8b5cf6)' },
];
const KEY = 'pocr_theme';

const ThemeContext = createContext(null);

export function ThemeProvider({ children }) {
  const [theme, setTheme] = useState(() => localStorage.getItem(KEY) || 'cyber');
  useEffect(() => {
    localStorage.setItem(KEY, theme);
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);
  return <ThemeContext.Provider value={{ theme, setTheme, themes: THEMES }}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used within ThemeProvider');
  return ctx;
}

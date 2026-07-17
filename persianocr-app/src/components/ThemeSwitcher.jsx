import React from 'react';
import { Sun, Moon } from 'lucide-react';
import { useTheme } from '../theme/ThemeContext';

/** Light/dark (paper/ink) toggle. */
export default function ThemeSwitcher() {
  const { theme, toggleTheme } = useTheme();
  const dark = theme === 'dark';
  return (
    <button className="icon-btn" onClick={toggleTheme} title={dark ? 'Light' : 'Dark'} aria-label="toggle theme">
      {dark ? <Sun size={18} /> : <Moon size={18} />}
    </button>
  );
}

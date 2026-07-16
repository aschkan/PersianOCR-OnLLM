import React from 'react';
import { useTheme } from '../theme/ThemeContext';

/** A compact row of palette swatches. */
export default function ThemeSwitcher() {
  const { theme, setTheme, themes } = useTheme();
  return (
    <div className="themebar">
      {themes.map((t) => (
        <button key={t.id} type="button" title={t.name} aria-label={t.name}
          className={`swatch ${theme === t.id ? 'active' : ''}`} style={{ background: t.swatch }}
          onClick={() => setTheme(t.id)} />
      ))}
    </div>
  );
}

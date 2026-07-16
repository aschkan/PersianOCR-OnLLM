/** @type {import('tailwindcss').Config} */
// PersianOCR-OnLLM — Tailwind + daisyUI. The palettes are daisyUI themes selected
// via `data-theme` (set by ThemeContext), so switching a palette restyles
// everything without touching component code.
module.exports = {
  content: ['./src/**/*.{js,jsx,ts,tsx}', './public/index.html'],
  theme: {
    extend: {
      fontFamily: { sans: ['Vazirmatn', 'Tahoma', 'system-ui', 'sans-serif'] },
      borderRadius: { xl: '14px', '2xl': '18px', '3xl': '24px' },
      keyframes: {
        rise: { '0%': { opacity: 0, transform: 'translateY(10px)' }, '100%': { opacity: 1, transform: 'none' } },
      },
      animation: { rise: 'rise .35s ease both' },
    },
  },
  plugins: [require('daisyui')],
  daisyui: {
    logs: false,
    themes: [
      {
        cyber: {
          primary: '#22d3ee', secondary: '#6366f1', accent: '#a855f7',
          neutral: '#0f1320', 'base-100': '#0a0c14', 'base-200': '#070912', 'base-300': '#11141f',
          info: '#22d3ee', success: '#34e8a0', warning: '#ffc24b', error: '#ff6b8a',
          '--rounded-box': '18px', '--rounded-btn': '12px', '--rounded-badge': '999px',
        },
      },
      {
        aurora: {
          primary: '#2dd4bf', secondary: '#3b82f6', accent: '#22c55e',
          neutral: '#0d1a18', 'base-100': '#081413', 'base-200': '#06100e', 'base-300': '#0e1c1a',
          info: '#3b82f6', success: '#34e8a0', warning: '#ffc24b', error: '#ff6b8a',
          '--rounded-box': '18px', '--rounded-btn': '12px', '--rounded-badge': '999px',
        },
      },
      {
        sunset: {
          primary: '#fb7185', secondary: '#f59e0b', accent: '#a855f7',
          neutral: '#1c0d18', 'base-100': '#160a14', 'base-200': '#120710', 'base-300': '#20111c',
          info: '#a855f7', success: '#34e8a0', warning: '#ffc24b', error: '#ff6b8a',
          '--rounded-box': '18px', '--rounded-btn': '12px', '--rounded-badge': '999px',
        },
      },
      {
        royal: {
          primary: '#d4af37', secondary: '#6d8bff', accent: '#b07cff',
          neutral: '#0e1124', 'base-100': '#0a0e1f', 'base-200': '#080a16', 'base-300': '#11152b',
          info: '#6d8bff', success: '#34e8a0', warning: '#ffc24b', error: '#ff6b8a',
          '--rounded-box': '18px', '--rounded-btn': '12px', '--rounded-badge': '999px',
        },
      },
      {
        light: {
          primary: '#0ea5e9', secondary: '#6366f1', accent: '#8b5cf6',
          neutral: '#e7ecf5', 'base-100': '#ffffff', 'base-200': '#eef2f9', 'base-300': '#e2e8f3',
          info: '#0ea5e9', success: '#16a34a', warning: '#d97706', error: '#e11d48',
          '--rounded-box': '18px', '--rounded-btn': '12px', '--rounded-badge': '999px',
        },
      },
    ],
  },
};

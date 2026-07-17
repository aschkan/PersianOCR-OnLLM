/** @type {import('tailwindcss').Config} */
// PersianOCR-OnLLM — its OWN design system (no daisyUI). A warm "paper & ink"
// document-scanner look: paper background, teal brand, saffron accent, light by
// default with a dark ("ink") mode. Colours live as CSS variables in styles.css
// and are switched by [data-theme]; the few utilities used in JSX map to them.
module.exports = {
  content: ['./src/**/*.{js,jsx,ts,tsx}', './public/index.html'],
  darkMode: ['selector', '[data-theme="dark"]'],
  theme: {
    extend: {
      fontFamily: { sans: ['Vazirmatn', 'Tahoma', 'system-ui', 'sans-serif'] },
      colors: {
        paper: 'rgb(var(--paper) / <alpha-value>)',
        surface: 'rgb(var(--surface) / <alpha-value>)',
        ink: 'rgb(var(--ink) / <alpha-value>)',
        brand: 'rgb(var(--brand) / <alpha-value>)',
        accent: 'rgb(var(--accent) / <alpha-value>)',
        line: 'rgb(var(--line) / <alpha-value>)',
      },
      borderRadius: { xl: '14px', '2xl': '18px', '3xl': '26px' },
    },
  },
  plugins: [],
};

// Used by the standalone `tailwindcss` CLI (npm run css) to build src/index.css
// from src/styles.css. CRA's own pipeline just imports the generated file.
module.exports = {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
};

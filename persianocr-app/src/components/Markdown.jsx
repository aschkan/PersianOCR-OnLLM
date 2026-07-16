import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

/**
 * Renders the model's Markdown transcription — GFM enables the pipe tables the
 * OCR prompt asks for (items / prices / totals). Wrapped in `.md` so styles.css
 * can style headings, lists and tables consistently in every palette.
 */
export default function Markdown({ children }) {
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{children || ''}</ReactMarkdown>
    </div>
  );
}

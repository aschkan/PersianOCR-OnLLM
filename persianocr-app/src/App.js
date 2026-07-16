import React, { Suspense, lazy } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { LangProvider } from './i18n/LangContext';
import { ThemeProvider } from './theme/ThemeContext';
import Layout from './components/Layout';
import { Spinner } from './components/ui';
import Home from './pages/Home';

// Heavier pages (markdown, image lists) are code-split so the first paint stays
// light for the upload screen.
const History = lazy(() => import('./pages/History'));
const ReceiptDetail = lazy(() => import('./pages/ReceiptDetail'));
const Settings = lazy(() => import('./pages/Settings'));

export default function App() {
  return (
    <LangProvider>
      <ThemeProvider>
        <BrowserRouter>
          <Layout>
            <Suspense fallback={<Spinner />}>
              <Routes>
                <Route path="/" element={<Home />} />
                <Route path="/history" element={<History />} />
                <Route path="/receipt/:id" element={<ReceiptDetail />} />
                <Route path="/settings" element={<Settings />} />
                <Route path="*" element={<Navigate to="/" replace />} />
              </Routes>
            </Suspense>
          </Layout>
        </BrowserRouter>
      </ThemeProvider>
    </LangProvider>
  );
}

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './components/App';

/**
 * Renderer entry point. esbuild bundles this into a single local script, which
 * is what the page's `script-src 'self'` policy allows.
 */
const container = document.getElementById('app');

if (container) {
  createRoot(container).render(
    <StrictMode>
      <App />
    </StrictMode>
  );
}

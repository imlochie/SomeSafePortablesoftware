import { createRoot } from 'react-dom/client';

import App from './App';
import { ErrorBoundary } from '@/components/error-boundary';
import { configureApiBaseUrl } from '@/lib/configure-api-base-url';

import './index.css';

// The desktop shell assigns its API port at runtime, so the base URL has to be
// resolved before any component mounts and fires a query. Mounting first and
// configuring later races the very first request, which then leaves as a
// relative path against the webview origin and cannot reach the local API.
void configureApiBaseUrl().then(() => {
  createRoot(document.getElementById('root')!, {
    // Keeps caught errors off reportError(), which would raise the dev overlay.
    onCaughtError: (error, errorInfo) => {
      console.error(error, errorInfo.componentStack);
    },
  }).render(
    <ErrorBoundary>
      <App />
    </ErrorBoundary>,
  );
});

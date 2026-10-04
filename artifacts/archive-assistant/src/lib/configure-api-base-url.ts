import { setBaseUrl } from '@workspace/api-client-react';

import { waitForDesktopApiBaseUrl } from './desktop-api-base-url';

/**
 * Points the generated API client at the right origin before anything renders.
 *
 * Precedence:
 *  1. `VITE_API_BASE_URL` — an explicit build-time override always wins.
 *  2. The desktop shell's injected base URL, awaited while running in Tauri.
 *  3. `null`, meaning relative `/api` paths. Correct in the browser, where the
 *     Vite dev server proxies `/api` to the API server.
 */
export async function configureApiBaseUrl(target: Window = window): Promise<string | null> {
  const configured = import.meta.env.VITE_API_BASE_URL?.trim();
  if (configured) {
    setBaseUrl(configured);
    return configured;
  }

  const desktop = await waitForDesktopApiBaseUrl(target);
  setBaseUrl(desktop ?? null);
  return desktop ?? null;
}

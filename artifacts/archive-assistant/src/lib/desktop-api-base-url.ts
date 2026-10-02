/**
 * Resolves the local API base URL the desktop shell injects at runtime.
 *
 * The packaged shell cannot know its API port ahead of time: `main.rs` starts
 * the sidecar with `PORT=0`, so the kernel assigns an ephemeral port that Node
 * only reports once it is listening. Rust therefore injects
 * `window.__ARCHIVE_API_BASE_URL__` with `window.eval` *after* the readiness
 * handshake succeeds.
 *
 * The webview, however, begins loading `index.html` the moment the window is
 * created. Reading the global while modules evaluate is a race the frontend
 * always loses: every request then leaves as a relative `/api/...` path against
 * the webview origin (`http://tauri.localhost` on Windows), which serves the
 * bundled assets and has no API behind it.
 *
 * In a browser the same relative path is correct, because the Vite dev server
 * proxies `/api` to the API. So the wait is scoped to the desktop shell.
 */

/** Dispatched on `window` by the Rust shell once the base URL global is set. */
export const DESKTOP_API_BASE_URL_EVENT = 'archive:api-base-url';

type DesktopWindow = Window & {
  __ARCHIVE_API_BASE_URL__?: string;
  __TAURI_INTERNALS__?: unknown;
};

/**
 * True when running inside a Tauri webview.
 *
 * Tauri v2 always defines `__TAURI_INTERNALS__` on the window before any
 * application script runs, independent of the allowlist or `withGlobalTauri`.
 */
export function isDesktopShell(target: Window = window): boolean {
  return typeof target !== 'undefined' && '__TAURI_INTERNALS__' in target;
}

export function readDesktopApiBaseUrl(target: Window = window): string | undefined {
  const value = (target as DesktopWindow).__ARCHIVE_API_BASE_URL__;
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/**
 * Resolves once the desktop shell has published its API base URL.
 *
 * Returns `undefined` immediately in a browser, where relative `/api` paths are
 * already correct. On timeout it also resolves `undefined` rather than
 * rejecting: the Rust shell paints its own startup error over the document when
 * the sidecar fails, and a rejected promise here would replace that specific
 * diagnosis with a generic unhandled rejection.
 */
export function waitForDesktopApiBaseUrl(
  target: Window = window,
  timeoutMs = 60_000,
): Promise<string | undefined> {
  if (!isDesktopShell(target)) return Promise.resolve(undefined);

  const immediate = readDesktopApiBaseUrl(target);
  if (immediate) return Promise.resolve(immediate);

  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: string | undefined) => {
      if (settled) return;
      settled = true;
      target.clearTimeout(timeout);
      target.clearInterval(poll);
      target.removeEventListener(DESKTOP_API_BASE_URL_EVENT, onPublished);
      resolve(value);
    };

    const onPublished = () => {
      const value = readDesktopApiBaseUrl(target);
      if (value) finish(value);
    };

    // The injected script may land between the read above and this listener
    // being attached, so poll as well rather than depending on the event alone.
    const poll = target.setInterval(onPublished, 50);
    const timeout = target.setTimeout(() => finish(readDesktopApiBaseUrl(target)), timeoutMs);
    target.addEventListener(DESKTOP_API_BASE_URL_EVENT, onPublished);
  });
}

/**
 * Absolute URL for a same-API path such as `/api/archive/scan/events`.
 *
 * `EventSource` never passes through the generated client, so it does not pick
 * up `setBaseUrl`. Left relative, an SSE stream resolves against the webview
 * origin and silently fails in the packaged desktop app while working in the
 * browser, where the dev server proxies `/api`.
 */
export function apiUrl(path: string, target: Window = window): string {
  const base = readDesktopApiBaseUrl(target);
  if (!base) return path;
  return `${base.replace(/\/+$/, '')}${path}`;
}

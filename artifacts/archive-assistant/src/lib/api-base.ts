// Shared resolution of the local API base URL.
//
// In browser/dev mode the Vite dev server proxies relative /api requests to the
// local Node API, so no base URL is needed. In the Tauri desktop shell the
// managed API sidecar runs on an assigned loopback port and the shell injects
// `window.__ARCHIVE_API_BASE_URL__` before the app renders.
//
// Raw browser APIs that cannot use the generated client's fetch wrapper (for
// example EventSource for Server-Sent Events) must resolve their URL through
// this helper so they reach the same API as every generated request.

type DesktopWindow = Window & {
  __ARCHIVE_API_BASE_URL__?: string;
};

export const apiBaseUrl: string | null =
  import.meta.env.VITE_API_BASE_URL?.trim()
  || (window as DesktopWindow).__ARCHIVE_API_BASE_URL__
  || null;

/** Build an absolute-or-relative URL for a raw API request such as SSE. */
export function apiUrl(path: string): string {
  return `${apiBaseUrl ?? ''}${path}`;
}

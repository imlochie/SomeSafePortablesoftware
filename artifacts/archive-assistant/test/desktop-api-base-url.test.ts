import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import {
  DESKTOP_API_BASE_URL_EVENT,
  apiUrl,
  isDesktopShell,
  readDesktopApiBaseUrl,
  waitForDesktopApiBaseUrl,
} from '../src/lib/desktop-api-base-url';

/**
 * Regression cover for the packaged launch failure reported as
 *
 *   "The local node did not answer"
 *
 * The bundled Node runtime started correctly and the sidecar passed its
 * readiness and health handshake -- the Rust shell only reveals the window
 * after `wait_for_health` succeeds, so seeing the React error state at all
 * proves the API was up and answering on 127.0.0.1.
 *
 * The break was in the browser half. `main.rs` starts the sidecar with
 * `PORT=0`, learns the ephemeral port from the readiness line, and only then
 * injects `window.__ARCHIVE_API_BASE_URL__`. The frontend read that global once
 * at module scope, which evaluates while the webview is still loading -- long
 * before the injection. `setBaseUrl` therefore received `null` and every
 * request went out as a relative `/api/...` path against the webview origin
 * (`http://tauri.localhost` on Windows), which serves the bundled assets and
 * has no API behind it.
 *
 * This never reproduces in the browser, where the Vite dev server proxies
 * `/api` to the API server and the relative path is correct.
 */

const srcDir = path.resolve(import.meta.dirname, '..', 'src');
const readSource = (relative: string) => readFileSync(path.join(srcDir, relative), 'utf8');

function fakeDesktopWindow(options: { desktop?: boolean } = {}) {
  const listeners = new Map<string, Set<() => void>>();
  const target = {
    __TAURI_INTERNALS__: options.desktop === false ? undefined : {},
    setInterval: ((handler: () => void, ms?: number) =>
      setInterval(handler, ms)) as Window['setInterval'],
    clearInterval: ((id: number) => clearInterval(id)) as Window['clearInterval'],
    setTimeout: ((handler: () => void, ms?: number) =>
      setTimeout(handler, ms)) as Window['setTimeout'],
    clearTimeout: ((id: number) => clearTimeout(id)) as Window['clearTimeout'],
    addEventListener: (type: string, listener: () => void) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(listener);
    },
    removeEventListener: (type: string, listener: () => void) => {
      listeners.get(type)?.delete(listener);
    },
    dispatchEvent: (event: { type: string }) => {
      listeners.get(event.type)?.forEach((listener) => listener());
      return true;
    },
  } as unknown as Window & { __ARCHIVE_API_BASE_URL__?: string };

  if (options.desktop === false) {
    delete (target as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  }
  return target;
}

describe('desktop API base URL', () => {
  it('detects the Tauri webview by an internal Tauri always defines', () => {
    expect(isDesktopShell(fakeDesktopWindow())).toBe(true);
    expect(isDesktopShell(fakeDesktopWindow({ desktop: false }))).toBe(false);
  });

  it('treats a missing or blank global as unresolved', () => {
    const target = fakeDesktopWindow();
    expect(readDesktopApiBaseUrl(target)).toBeUndefined();
    target.__ARCHIVE_API_BASE_URL__ = '   ';
    expect(readDesktopApiBaseUrl(target)).toBeUndefined();
    target.__ARCHIVE_API_BASE_URL__ = 'http://127.0.0.1:51731';
    expect(readDesktopApiBaseUrl(target)).toBe('http://127.0.0.1:51731');
  });

  it('resolves immediately in a browser so relative paths keep working', async () => {
    await expect(waitForDesktopApiBaseUrl(fakeDesktopWindow({ desktop: false }))).resolves.toBeUndefined();
  });

  // The exact shipped failure: the global is injected after the frontend has
  // already evaluated. Reading once at module scope loses this race.
  it('waits for a base URL injected after the frontend has loaded', async () => {
    const target = fakeDesktopWindow();
    const pending = waitForDesktopApiBaseUrl(target);

    await new Promise((resolve) => setTimeout(resolve, 20));
    target.__ARCHIVE_API_BASE_URL__ = 'http://127.0.0.1:51731';
    target.dispatchEvent({ type: DESKTOP_API_BASE_URL_EVENT } as Event);

    await expect(pending).resolves.toBe('http://127.0.0.1:51731');
  });

  it('still resolves when only the global is set and no event fires', async () => {
    const target = fakeDesktopWindow();
    const pending = waitForDesktopApiBaseUrl(target);
    setTimeout(() => {
      target.__ARCHIVE_API_BASE_URL__ = 'http://127.0.0.1:8080';
    }, 20);
    await expect(pending).resolves.toBe('http://127.0.0.1:8080');
  });

  it('resolves undefined on timeout instead of rejecting', async () => {
    vi.useFakeTimers();
    try {
      const target = fakeDesktopWindow();
      const pending = waitForDesktopApiBaseUrl(target, 30_000);
      await vi.advanceTimersByTimeAsync(30_001);
      await expect(pending).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('makes SSE URLs absolute in the desktop shell only', () => {
    const browser = fakeDesktopWindow({ desktop: false });
    expect(apiUrl('/api/archive/scan/events', browser)).toBe('/api/archive/scan/events');

    const desktop = fakeDesktopWindow();
    desktop.__ARCHIVE_API_BASE_URL__ = 'http://127.0.0.1:51731/';
    expect(apiUrl('/api/archive/scan/events', desktop)).toBe(
      'http://127.0.0.1:51731/api/archive/scan/events',
    );
  });
});

describe('frontend startup ordering', () => {
  it('configures the base URL before mounting React', () => {
    const main = readSource('main.tsx');
    // Mounting first and configuring later is the bug: the first query fires
    // against the webview origin before the base URL is known.
    expect(main).toContain('configureApiBaseUrl');
    // Compare call sites, not the import line, which always sorts first.
    const configureAt = main.indexOf('configureApiBaseUrl().then');
    const renderAt = main.indexOf('createRoot(');
    expect(configureAt).toBeGreaterThanOrEqual(0);
    expect(renderAt).toBeGreaterThan(configureAt);
  });

  it('never reads the injected global at module scope in App', () => {
    const app = readSource('App.tsx');
    // This exact expression shipped the bug -- it evaluates before injection.
    expect(app).not.toContain('__ARCHIVE_API_BASE_URL__');
    expect(app).not.toMatch(/^setBaseUrl\(/m);
  });

  it('routes every EventSource through the base-URL helper', () => {
    // EventSource bypasses the generated client, so setBaseUrl does not apply.
    for (const relative of ['App.tsx', 'hooks/use-archive-scan-events.ts']) {
      const source = readSource(relative);
      const streams = Array.from(source.matchAll(/new EventSource\(([^)]*)\)/g), (m) => m[1]);
      expect(streams.length).toBeGreaterThan(0);
      for (const argument of streams) {
        expect(argument).toContain('apiUrl(');
      }
    }
  });

  it('keeps an explicit build-time override ahead of the desktop value', async () => {
    const configure = readSource('lib/configure-api-base-url.ts');
    const overrideAt = configure.indexOf('import.meta.env.VITE_API_BASE_URL');
    const desktopAt = configure.indexOf('await waitForDesktopApiBaseUrl');
    expect(overrideAt).toBeGreaterThanOrEqual(0);
    expect(desktopAt).toBeGreaterThan(overrideAt);
  });
});

describe('rust base URL injection', () => {
  const mainRs = readFileSync(
    path.resolve(import.meta.dirname, '..', 'src-tauri', 'src', 'main.rs'),
    'utf8',
  );

  it('announces the base URL with the event the frontend waits on', () => {
    expect(mainRs).toContain('window.__ARCHIVE_API_BASE_URL__');
    expect(mainRs).toContain(DESKTOP_API_BASE_URL_EVENT);
  });

  it('injects only after the sidecar is healthy', () => {
    // Injecting earlier would hand the frontend a port that is not listening.
    const healthAt = mainRs.indexOf('wait_for_health(port)');
    const injectAt = mainRs.indexOf('window.__ARCHIVE_API_BASE_URL__');
    expect(healthAt).toBeGreaterThanOrEqual(0);
    expect(injectAt).toBeGreaterThan(healthAt);
  });
});

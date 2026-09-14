import { render, screen, act, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ArchiveScanPanel } from '../src/components/archive-scan-panel';
import { useArchiveScanEvents, type ScanLiveState } from '../src/hooks/use-archive-scan-events';

/**
 * Live archive scan observability, browser side.
 *
 * The panel is the operator's window into a scan that can run for tens of
 * thousands of files, so these tests hold it to the properties that make it
 * trustworthy: it reports real scanner stages, it distinguishes a skipped
 * FFprobe from a pending one, it never grows without bound, and it says so
 * out loud when the feed drops rather than silently freezing stale numbers.
 */

const IDLE: ScanLiveState = {
  connected: false,
  sessionId: null,
  status: 'idle',
  startedAt: null,
  completedAt: null,
  roots: [],
  discovered: 0,
  discoveryComplete: false,
  scanned: 0,
  failed: 0,
  activeItems: [],
  currentItem: null,
  recentItems: [],
  lastError: null,
};

function scanning(overrides: Partial<ScanLiveState> = {}): ScanLiveState {
  return {
    ...IDLE,
    connected: true,
    sessionId: 'session-1',
    status: 'scanning',
    startedAt: new Date(Date.now() - 5_000).toISOString(),
    discovered: 100,
    scanned: 25,
    ...overrides,
  };
}

function activeItem(overrides: Record<string, unknown> = {}) {
  return {
    path: 'D:/archive/movies/The.Matrix.1999.mkv',
    filename: 'The.Matrix.1999.mkv',
    title: 'The.Matrix.1999',
    root: 'D:/archive/movies',
    mediaType: 'movie' as const,
    startedAt: new Date().toISOString(),
    stages: [{ stage: 'inspect' as const, status: 'active' as const, at: new Date().toISOString() }],
    ...overrides,
  };
}

describe('ArchiveScanPanel', () => {
  it('invites a scan when no session has ever run', () => {
    render(<ArchiveScanPanel live={IDLE} />);
    expect(screen.getByTestId('panel-archive-scan')).toBeInTheDocument();
    expect(screen.getByText(/START A SCAN TO WATCH THE PIPELINE/i)).toBeInTheDocument();
  });

  it('counts scanned and discovered separately while discovery runs', () => {
    render(<ArchiveScanPanel live={scanning({ discovered: 400, scanned: 100, failed: 3 })} />);
    expect(screen.getByTestId('status-archive-scan-live')).toHaveTextContent('SCANNING');
    expect(screen.getByTestId('text-scan-counter').textContent).toContain('100');
    expect(screen.getByTestId('text-scan-counter').textContent).toContain('400');
    expect(screen.getByText(/DISCOVERING ARCHIVE/)).toBeInTheDocument();
    expect(screen.getByText('FAILURES 3')).toBeInTheDocument();
    // `discovered` is still moving, so 100/400 is not 25% of the work: the
    // real total was unknown at this point. No percentage may be published.
    expect(screen.getByRole('progressbar')).not.toHaveAttribute('aria-valuenow');
  });

  it('shows the current file with the scanner\'s real stages', () => {
    const current = activeItem({
      stages: [
        { stage: 'inspect', status: 'done', at: new Date().toISOString() },
        { stage: 'probe', status: 'active', at: new Date().toISOString() },
      ],
    });
    render(<ArchiveScanPanel live={scanning({ currentItem: current, activeItems: [current] })} />);
    const panel = screen.getByTestId('panel-archive-scan-current');
    expect(panel).toHaveTextContent('The.Matrix.1999');
    expect(panel).toHaveTextContent('MOVIE');
    expect(panel).toHaveTextContent('INSPECT');
    expect(panel).toHaveTextContent('FFPROBE');
    expect(panel).toHaveTextContent('REGISTER');
  });

  it('marks FFprobe as skipped -- not pending -- for an unchanged file', () => {
    // The scanner skips FFprobe when a file is unchanged. Showing that as a
    // pending stage would imply the scan had stalled mid-file.
    const current = activeItem({
      stages: [
        { stage: 'inspect', status: 'done', at: new Date().toISOString() },
        { stage: 'register', status: 'active', at: new Date().toISOString() },
      ],
    });
    render(<ArchiveScanPanel live={scanning({ currentItem: current, activeItems: [current] })} />);
    expect(screen.getByTestId('panel-archive-scan-current')).toHaveTextContent('SKIP');
  });

  it('announces a dropped feed instead of silently showing stale numbers', () => {
    const { rerender } = render(<ArchiveScanPanel live={scanning()} />);
    expect(screen.queryByTestId('status-archive-scan-reconnecting')).toBeNull();
    rerender(<ArchiveScanPanel live={scanning({ connected: false })} />);
    expect(screen.getByTestId('status-archive-scan-reconnecting')).toHaveTextContent('FEED RECONNECTING');
  });

  it('distinguishes registered, unchanged, and failed files in recent history', () => {
    const live = scanning({
      recentItems: [
        { path: '/a.mkv', filename: 'a.mkv', title: 'Alpha', mediaType: 'movie', outcome: 'registered', error: null, completedAt: new Date().toISOString(), durationMs: 120 },
        { path: '/b.mkv', filename: 'b.mkv', title: 'Beta', mediaType: 'movie', outcome: 'unchanged', error: null, completedAt: new Date().toISOString(), durationMs: 5 },
        { path: '/c.mkv', filename: 'c.mkv', title: 'Gamma', mediaType: 'tv', outcome: 'failed', error: 'invalid media', completedAt: new Date().toISOString(), durationMs: null },
      ],
    });
    render(<ArchiveScanPanel live={live} />);
    const recent = screen.getByTestId('panel-archive-scan-recent');
    expect(recent).toHaveTextContent('REGISTERED');
    expect(recent).toHaveTextContent('UNCHANGED');
    expect(recent).toHaveTextContent('FAILED');
    expect(screen.getAllByTestId('row-archive-scan-recent')).toHaveLength(3);
  });

  it('surfaces a scan failure reason', () => {
    render(<ArchiveScanPanel live={scanning({ status: 'failed', lastError: 'D:/archive: directory could not be read' })} />);
    expect(screen.getByTestId('status-archive-scan-live')).toHaveTextContent('FAILED');
    expect(screen.getByTestId('status-archive-scan-error')).toHaveTextContent('directory could not be read');
  });
});

// ---------------------------------------------------------------------------
// Hook: event application, bounding, and reconnect
// ---------------------------------------------------------------------------

type Listener = (event: { data: string }) => void;

class MockEventSource {
  static instances: MockEventSource[] = [];
  listeners = new Map<string, Listener[]>();
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  constructor(public url: string) {
    MockEventSource.instances.push(this);
  }
  addEventListener(name: string, listener: Listener) {
    const existing = this.listeners.get(name) ?? [];
    existing.push(listener);
    this.listeners.set(name, existing);
  }
  close() {
    this.closed = true;
  }
  emit(name: string, payload: unknown) {
    for (const listener of this.listeners.get(name) ?? []) {
      listener({ data: JSON.stringify(payload) });
    }
  }
}

function HookProbe({ onState }: { onState: (state: ScanLiveState) => void }) {
  const state = useArchiveScanEvents();
  onState(state);
  return <div data-testid="scanned">{state.scanned}</div>;
}

describe('useArchiveScanEvents', () => {
  beforeEach(() => {
    MockEventSource.instances = [];
    vi.stubGlobal('EventSource', MockEventSource as unknown as typeof EventSource);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  /** Flush the hook's 100ms coalescing window. */
  const flush = async () => {
    await act(async () => {
      vi.advanceTimersByTime(150);
    });
  };

  it('subscribes to the archive scan stream with a relative URL', () => {
    render(<HookProbe onState={() => {}} />);
    expect(MockEventSource.instances).toHaveLength(1);
    // Must stay relative: the browser is not the API host in dev or desktop.
    expect(MockEventSource.instances[0].url).toBe('/api/archive/scan/events');
  });

  it('applies the snapshot then live events, and coalesces renders', async () => {
    let latest: ScanLiveState = IDLE;
    render(<HookProbe onState={(state) => { latest = state; }} />);
    const source = MockEventSource.instances[0];

    await act(async () => {
      source.onopen?.();
      source.emit('snapshot', {
        scan: {},
        live: { ...IDLE, sessionId: 's1', status: 'scanning', discovered: 10, scanned: 2 },
      });
    });
    await flush();
    expect(latest.status).toBe('scanning');
    expect(latest.scanned).toBe(2);
    expect(latest.connected).toBe(true);

    await act(async () => {
      source.emit('scan.progress', {
        type: 'scan.progress', sessionId: 's1', timestamp: new Date().toISOString(),
        scanned: 7, failed: 1, discovered: 10, discoveryComplete: true,
      });
    });
    await flush();
    expect(latest.scanned).toBe(7);
    expect(latest.failed).toBe(1);
    expect(latest.discoveryComplete).toBe(true);
  });

  it('tracks a file through its stages and into recent history', async () => {
    let latest: ScanLiveState = IDLE;
    render(<HookProbe onState={(state) => { latest = state; }} />);
    const source = MockEventSource.instances[0];
    const path = 'D:/archive/movies/Toy.Story.1995.mkv';
    const base = { sessionId: 's1', timestamp: new Date().toISOString() };

    await act(async () => {
      source.emit('scan.started', { ...base, type: 'scan.started', roots: ['D:/archive/movies'] });
      source.emit('scan.file.started', {
        ...base, type: 'scan.file.started', path, filename: 'Toy.Story.1995.mkv',
        title: 'Toy.Story.1995', root: 'D:/archive/movies', mediaType: 'movie',
      });
      source.emit('scan.file.stage', { ...base, type: 'scan.file.stage', path, filename: 'Toy.Story.1995.mkv', stage: 'probe' });
    });
    await flush();
    expect(latest.currentItem?.path).toBe(path);
    expect(latest.currentItem?.stages.find((s) => s.stage === 'inspect')?.status).toBe('done');
    expect(latest.currentItem?.stages.find((s) => s.stage === 'probe')?.status).toBe('active');

    await act(async () => {
      source.emit('scan.file.completed', {
        ...base, type: 'scan.file.completed', path, filename: 'Toy.Story.1995.mkv',
        outcome: 'registered', scanned: 1, failed: 0, durationMs: 42,
      });
    });
    await flush();
    expect(latest.currentItem).toBeNull();
    expect(latest.recentItems[0].outcome).toBe('registered');
    expect(latest.recentItems[0].path).toBe(path);
  });

  it('bounds recent history so a 37,000-file scan cannot bloat the browser', async () => {
    let latest: ScanLiveState = IDLE;
    render(<HookProbe onState={(state) => { latest = state; }} />);
    const source = MockEventSource.instances[0];
    const base = { sessionId: 's1', timestamp: new Date().toISOString() };

    await act(async () => {
      for (let index = 0; index < 500; index += 1) {
        source.emit('scan.file.completed', {
          ...base, type: 'scan.file.completed',
          path: `/archive/file-${index}.mkv`, filename: `file-${index}.mkv`,
          outcome: 'registered', scanned: index + 1, failed: 0, durationMs: 5,
        });
      }
    });
    await flush();
    expect(latest.recentItems).toHaveLength(20);
    expect(latest.scanned).toBe(500);
    // Newest first, so the operator sees what just happened.
    expect(latest.recentItems[0].path).toBe('/archive/file-499.mkv');
  });

  it('marks the feed disconnected on error so the UI can fall back to polling', async () => {
    let latest: ScanLiveState = IDLE;
    render(<HookProbe onState={(state) => { latest = state; }} />);
    const source = MockEventSource.instances[0];

    await act(async () => { source.onopen?.(); });
    await flush();
    expect(latest.connected).toBe(true);

    await act(async () => { source.onerror?.(); });
    await flush();
    expect(latest.connected).toBe(false);
  });

  it('resynchronizes from the snapshot after a reconnect', async () => {
    let latest: ScanLiveState = IDLE;
    render(<HookProbe onState={(state) => { latest = state; }} />);
    const source = MockEventSource.instances[0];

    await act(async () => {
      source.onopen?.();
      source.emit('snapshot', { scan: {}, live: { ...IDLE, sessionId: 's1', status: 'scanning', scanned: 5, discovered: 50 } });
    });
    await flush();
    expect(latest.scanned).toBe(5);

    // A drop, then the server's automatic retry delivers a fresh snapshot that
    // reflects everything that happened while the browser was away.
    await act(async () => { source.onerror?.(); });
    await flush();
    await act(async () => {
      source.onopen?.();
      source.emit('snapshot', { scan: {}, live: { ...IDLE, sessionId: 's1', status: 'scanning', scanned: 44, discovered: 50 } });
    });
    await flush();
    expect(latest.scanned).toBe(44);
    expect(latest.connected).toBe(true);
  });

  it('ignores malformed frames rather than tearing down the feed', async () => {
    let latest: ScanLiveState = IDLE;
    render(<HookProbe onState={(state) => { latest = state; }} />);
    const source = MockEventSource.instances[0];

    await act(async () => {
      source.emit('snapshot', { scan: {}, live: { ...IDLE, status: 'scanning', scanned: 3 } });
    });
    await flush();

    await act(async () => {
      for (const listener of source.listeners.get('scan.progress') ?? []) {
        listener({ data: 'not-json' });
      }
    });
    await flush();
    expect(latest.scanned).toBe(3);
    expect(latest.status).toBe('scanning');
  });

  it('closes the stream on unmount', () => {
    const { unmount } = render(<HookProbe onState={() => {}} />);
    const source = MockEventSource.instances[0];
    expect(source.closed).toBe(false);
    unmount();
    expect(source.closed).toBe(true);
  });
});

/**
 * Scan counter semantics.
 *
 * Discovery and scanning run concurrently, so `discovered` keeps climbing
 * while files are scanned. The panel used to render `scanned / discovered`
 * with a percentage bar computed from that moving denominator, which showed
 * "432 / 436" — a 99% bar — on an archive whose real total turned out to be
 * 37,739. These tests pin the honest presentation in both states.
 */
describe('ArchiveScanPanel progress semantics', () => {
  it('reports scanned and discovered separately while discovery is still running', () => {
    render(
      <ArchiveScanPanel
        live={scanning({ discovered: 436, scanned: 432, discoveryComplete: false })}
        scanning
      />,
    );

    const counter = screen.getByTestId('text-scan-counter');

    // Both numbers must be present and explicitly labelled.
    expect(counter.textContent).toContain('432');
    expect(counter.textContent).toContain('scanned');
    expect(counter.textContent).toContain('436');
    expect(counter.textContent).toContain('discovered');

    // The "432 / 436" fraction is exactly the misleading form. It must be gone.
    expect(counter.textContent).not.toMatch(/432\s*\/\s*436/);

    // The state line must say the total is not yet known.
    expect(screen.getByTestId('text-scan-discovery-state').textContent).toMatch(
      /NOT YET KNOWN|DISCOVERING/,
    );

    // No determinate percentage may be published while discovery is active:
    // the indeterminate bar carries no aria-valuenow at all.
    const bar = screen.getByTestId('progress-archive-scan-indeterminate');
    expect(bar.getAttribute('aria-valuenow')).toBeNull();
    expect(screen.queryByTestId('progress-archive-scan')).toBeNull();
  });

  it('shows a real fraction and percentage once discovery has completed', () => {
    render(
      <ArchiveScanPanel
        live={scanning({ discovered: 37_739, scanned: 432, discoveryComplete: true })}
        scanning
      />,
    );

    // With a fixed denominator the fraction is meaningful again.
    const counter = screen.getByTestId('text-scan-counter');
    expect(counter.textContent).toContain('432');
    expect(counter.textContent).toContain('37,739');
    expect(counter.textContent).toMatch(/432\s*\/\s*37,739/);

    expect(screen.getByTestId('text-scan-discovery-state').textContent).toContain(
      'DISCOVERY COMPLETE',
    );

    // 432 of 37,739 is 1%, not the 99% the old moving denominator implied.
    const bar = screen.getByTestId('progress-archive-scan');
    expect(bar.getAttribute('aria-valuenow')).toBe('1');
    expect(screen.queryByTestId('progress-archive-scan-indeterminate')).toBeNull();
  });

  it('does not imply completion when discovery has found nothing yet', () => {
    render(
      <ArchiveScanPanel
        live={scanning({ discovered: 0, scanned: 0, discoveryComplete: false })}
        scanning
      />,
    );

    // discovered === 0 must not render a bare "0 / 0" or a 0-of-0 percentage.
    expect(screen.getByTestId('text-scan-counter').textContent).not.toContain('/');
    expect(screen.getByTestId('progress-archive-scan-indeterminate')).toBeTruthy();
  });

  it('keeps the live event feed prominent during a scan', () => {
    render(
      <ArchiveScanPanel
        live={scanning({
          discovered: 436,
          scanned: 432,
          discoveryComplete: false,
          currentItem: activeItem(),
          activeItems: [activeItem()],
        })}
        scanning
      />,
    );

    // The feed is the useful part of this panel and must survive the counter fix.
    expect(screen.getByTestId('panel-archive-scan')).toBeTruthy();
    expect(screen.getAllByText(/The\.Matrix\.1999/).length).toBeGreaterThan(0);
  });
});

/**
 * Live feed wiring.
 *
 * The feed was reported missing in a packaged build. The wiring was in fact
 * intact -- what is absent between scans is the detailed feed body, because
 * the server holds live scan state in memory and reports `idle` after a
 * restart. These tests pin the wiring itself so a genuine disappearance
 * (an unmounted panel, a dropped subscription, a relative SSE URL) fails
 * here rather than on Windows.
 */
describe('live feed wiring', () => {
  it('subscribes to the scan event stream through the resolved API base URL', async () => {
    // A relative URL resolves against the webview origin in the packaged app,
    // which serves assets and has no API behind it. That regression is exactly
    // what this asserts against.
    const { apiUrl } = await import('../src/lib/desktop-api-base-url');
    const target = { __ARCHIVE_API_BASE_URL__: 'http://127.0.0.1:51234' } as unknown as Window;
    expect(apiUrl('/api/archive/scan/events', target)).toBe(
      'http://127.0.0.1:51234/api/archive/scan/events',
    );
  });

  it('keeps the panel mounted and announces the feed before any scan exists', () => {
    // Between scans the server reports idle, so only this strip renders. It
    // must still be present and must still report connection state, otherwise
    // the operator cannot tell a working feed from a broken one.
    render(<ArchiveScanPanel live={{ ...IDLE, connected: true }} />);
    const panel = screen.getByTestId('panel-archive-scan');
    expect(panel).toBeInTheDocument();
    expect(panel.textContent).toContain('LIVE FEED CONNECTED');
  });

  it('distinguishes a connected feed from one still connecting', () => {
    render(<ArchiveScanPanel live={{ ...IDLE, connected: false }} />);
    expect(screen.getByTestId('panel-archive-scan').textContent).toContain('LIVE FEED');
    expect(screen.getByTestId('panel-archive-scan').textContent).not.toContain('CONNECTED');
  });

  it('renders the full feed body once a session is live', () => {
    // The detailed feed is gated on there being a session at all. This is the
    // property that makes the feed look "gone" after a restart, and it must
    // hold the moment a scan starts.
    render(
      <ArchiveScanPanel
        live={scanning({
          currentItem: activeItem(),
          activeItems: [activeItem()],
          recentItems: [
            {
              path: 'D:/archive/movies/Heat.1995.mkv',
              filename: 'Heat.1995.mkv',
              title: 'Heat.1995',
              root: 'D:/archive/movies',
              mediaType: 'movie' as const,
              status: 'completed' as const,
              at: new Date().toISOString(),
            } as never,
          ],
        })}
        scanning
      />,
    );

    expect(screen.getByTestId('panel-archive-scan-current')).toBeInTheDocument();
    expect(screen.getByTestId('panel-archive-scan-progress')).toBeInTheDocument();
    // The real scanner stages must still be labelled.
    expect(screen.getByText('INSPECT')).toBeInTheDocument();
    expect(screen.getByText('FFPROBE')).toBeInTheDocument();
    expect(screen.getByText('REGISTER')).toBeInTheDocument();
  });
});

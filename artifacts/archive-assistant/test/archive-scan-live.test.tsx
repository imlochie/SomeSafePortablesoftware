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

  it('reports progress against discovery and keeps counting while discovery runs', () => {
    render(<ArchiveScanPanel live={scanning({ discovered: 400, scanned: 100, failed: 3 })} />);
    expect(screen.getByTestId('status-archive-scan-live')).toHaveTextContent('SCANNING');
    expect(screen.getByText('100')).toBeInTheDocument();
    expect(screen.getByText(/\/ 400/)).toBeInTheDocument();
    expect(screen.getByText(/STILL DISCOVERING/)).toBeInTheDocument();
    expect(screen.getByText('FAILURES 3')).toBeInTheDocument();
    // 100/400 = 25%: the bar reports real progress, not an animation.
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '25');
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

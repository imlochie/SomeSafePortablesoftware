import { useEffect, useRef, useState } from 'react';
import { apiUrl } from '@/lib/api-base';

// ---------------------------------------------------------------------------
// Archive scan event stream (Server-Sent Events)
//
// Mirrors the backend event model in artifacts/api-server/src/services/scan-events.ts.
// The stream sends an initial `snapshot` event and then live scan events; the
// hook keeps only a small bounded working set (current item, up to 20 recent
// items, aggregate progress) so a 37,000-file scan never bloats the browser.
// ---------------------------------------------------------------------------

export type ScanStageName = 'inspect' | 'probe' | 'register';
export type ScanFileOutcome = 'registered' | 'unchanged' | 'failed';
export type ScanMediaType = 'movie' | 'tv';
export type ScanLiveStatus = 'idle' | 'scanning' | 'completed' | 'failed';

export type ScanStage = { stage: ScanStageName; status: 'active' | 'done'; at: string };

export type ScanActiveItem = {
  path: string;
  filename: string;
  title: string;
  root: string | null;
  mediaType: ScanMediaType | null;
  startedAt: string;
  stages: ScanStage[];
};

export type ScanRecentItem = {
  path: string;
  filename: string;
  title: string;
  mediaType: ScanMediaType | null;
  outcome: ScanFileOutcome;
  error: string | null;
  completedAt: string;
  durationMs: number | null;
};

type ScanEvent =
  | { type: 'scan.started'; sessionId: string; timestamp: string; roots: string[] }
  | { type: 'scan.file.discovered'; sessionId: string; timestamp: string; path: string; filename: string; title: string; root: string | null; mediaType: ScanMediaType | null; discovered: number }
  | { type: 'scan.file.started'; sessionId: string; timestamp: string; path: string; filename: string; title: string; root: string | null; mediaType: ScanMediaType | null }
  | { type: 'scan.file.stage'; sessionId: string; timestamp: string; path: string; filename: string; stage: ScanStageName }
  | { type: 'scan.file.completed'; sessionId: string; timestamp: string; path: string; filename: string; outcome: 'registered' | 'unchanged'; scanned: number; failed: number; durationMs: number }
  | { type: 'scan.file.failed'; sessionId: string; timestamp: string; path: string; filename: string; error: string; scanned: number; failed: number }
  | { type: 'scan.progress'; sessionId: string; timestamp: string; scanned: number; failed: number; discovered: number; discoveryComplete: boolean }
  | { type: 'scan.completed'; sessionId: string; timestamp: string; scanned: number; failed: number; discovered: number; durationMs: number; lastError: string | null }
  | { type: 'scan.failed'; sessionId: string; timestamp: string; error: string; scanned: number; failed: number; discovered: number; durationMs: number };

export type ScanLiveState = {
  connected: boolean;
  sessionId: string | null;
  status: ScanLiveStatus;
  startedAt: string | null;
  completedAt: string | null;
  roots: string[];
  discovered: number;
  discoveryComplete: boolean;
  scanned: number;
  failed: number;
  activeItems: ScanActiveItem[];
  currentItem: ScanActiveItem | null;
  recentItems: ScanRecentItem[];
  lastError: string | null;
};

const RECENT_LIMIT = 20;
const ACTIVE_LIMIT = 32;
const FLUSH_DELAY_MS = 100;

const IDLE_STATE: ScanLiveState = {
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

const SCAN_EVENT_NAMES = [
  'scan.started',
  'scan.file.discovered',
  'scan.file.started',
  'scan.file.stage',
  'scan.file.completed',
  'scan.file.failed',
  'scan.progress',
  'scan.completed',
  'scan.failed',
] as const;

function markStage(item: ScanActiveItem, stage: ScanStageName) {
  const existing = item.stages.find((entry) => entry.stage === stage);
  if (existing) {
    existing.status = 'active';
    existing.at = new Date().toISOString();
    return;
  }
  for (const entry of item.stages) entry.status = 'done';
  item.stages.push({ stage, status: 'active', at: new Date().toISOString() });
}

function finishFile(
  state: ScanLiveState,
  event: { path: string; filename: string; timestamp: string },
  outcome: ScanFileOutcome,
  error: string | null,
  durationMs: number | null,
) {
  const active = state.activeItems.find((item) => item.path === event.path);
  const recent: ScanRecentItem = {
    path: event.path,
    filename: active?.filename ?? event.filename,
    title: active?.title ?? event.filename,
    mediaType: active?.mediaType ?? null,
    outcome,
    error,
    completedAt: event.timestamp,
    durationMs: active ? (durationMs ?? Date.parse(event.timestamp) - Date.parse(active.startedAt)) : durationMs,
  };
  state.activeItems = state.activeItems.filter((item) => item.path !== event.path);
  state.currentItem = state.activeItems.length ? state.activeItems[state.activeItems.length - 1] : null;
  state.recentItems = [recent, ...state.recentItems].slice(0, RECENT_LIMIT);
}

function applySnapshot(state: ScanLiveState, snapshot: { live?: Partial<ScanLiveState> } | null) {
  const live = snapshot?.live;
  if (!live) return;
  state.sessionId = live.sessionId ?? null;
  state.status = live.status ?? 'idle';
  state.startedAt = live.startedAt ?? null;
  state.completedAt = live.completedAt ?? null;
  state.roots = live.roots ?? [];
  state.discovered = live.discovered ?? 0;
  state.discoveryComplete = live.discoveryComplete ?? false;
  state.scanned = live.scanned ?? 0;
  state.failed = live.failed ?? 0;
  state.activeItems = (live.activeItems ?? []).slice(0, ACTIVE_LIMIT);
  state.currentItem = live.currentItem ?? null;
  state.recentItems = (live.recentItems ?? []).slice(0, RECENT_LIMIT);
  state.lastError = live.lastError ?? null;
}

function applyEvent(state: ScanLiveState, event: ScanEvent): 'finished' | 'started' | null {
  switch (event.type) {
    case 'scan.started':
      state.sessionId = event.sessionId;
      state.status = 'scanning';
      state.startedAt = event.timestamp;
      state.completedAt = null;
      state.roots = event.roots;
      state.discovered = 0;
      state.discoveryComplete = false;
      state.scanned = 0;
      state.failed = 0;
      state.activeItems = [];
      state.currentItem = null;
      state.recentItems = [];
      state.lastError = null;
      return 'started';
    case 'scan.file.discovered':
      state.discovered = event.discovered;
      return null;
    case 'scan.file.started': {
      const item: ScanActiveItem = {
        path: event.path,
        filename: event.filename,
        title: event.title,
        root: event.root,
        mediaType: event.mediaType,
        startedAt: event.timestamp,
        stages: [{ stage: 'inspect', status: 'active', at: event.timestamp }],
      };
      state.activeItems = [...state.activeItems.filter((entry) => entry.path !== event.path), item].slice(-ACTIVE_LIMIT);
      state.currentItem = item;
      return null;
    }
    case 'scan.file.stage': {
      const item = state.activeItems.find((entry) => entry.path === event.path);
      if (item) markStage(item, event.stage);
      return null;
    }
    case 'scan.file.completed':
      state.scanned = Math.max(state.scanned, event.scanned);
      state.failed = Math.max(state.failed, event.failed);
      finishFile(state, event, event.outcome, null, event.durationMs);
      return null;
    case 'scan.file.failed':
      state.scanned = Math.max(state.scanned, event.scanned);
      state.failed = Math.max(state.failed, event.failed);
      finishFile(state, event, 'failed', event.error, null);
      return null;
    case 'scan.progress':
      state.scanned = Math.max(state.scanned, event.scanned);
      state.failed = Math.max(state.failed, event.failed);
      state.discovered = Math.max(state.discovered, event.discovered);
      state.discoveryComplete = state.discoveryComplete || event.discoveryComplete;
      return null;
    case 'scan.completed':
      state.status = 'completed';
      state.completedAt = event.timestamp;
      state.discoveryComplete = true;
      state.scanned = Math.max(state.scanned, event.scanned);
      state.failed = Math.max(state.failed, event.failed);
      state.discovered = Math.max(state.discovered, event.discovered);
      state.lastError = event.lastError;
      return 'finished';
    case 'scan.failed':
      state.status = 'failed';
      state.completedAt = event.timestamp;
      state.discoveryComplete = true;
      state.lastError = event.error;
      state.scanned = Math.max(state.scanned, event.scanned);
      state.failed = Math.max(state.failed, event.failed);
      state.discovered = Math.max(state.discovered, event.discovered);
      return 'finished';
  }
}

/**
 * Subscribe to /api/archive/scan/events while mounted.
 *
 * The EventSource reconnects automatically (the server advertises a retry
 * interval); every (re)connection begins with a fresh snapshot event, so state
 * resynchronizes after any drop.
 */
export function useArchiveScanEvents(options?: { onScanFinished?: () => void; onScanStarted?: () => void }) {
  const [state, setState] = useState<ScanLiveState>(IDLE_STATE);
  const workingRef = useRef<ScanLiveState>({ ...IDLE_STATE });
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const callbacksRef = useRef(options);
  callbacksRef.current = options;

  useEffect(() => {
    const url = apiUrl('/api/archive/scan/events');
    const source = new EventSource(url);
    let disposed = false;

    const scheduleFlush = () => {
      if (flushTimerRef.current !== null || disposed) return;
      flushTimerRef.current = setTimeout(() => {
        flushTimerRef.current = null;
        if (disposed) return;
        setState({ ...workingRef.current, activeItems: workingRef.current.activeItems.map((item) => ({ ...item, stages: item.stages.map((stage) => ({ ...stage })) })), recentItems: workingRef.current.recentItems.map((item) => ({ ...item })), roots: [...workingRef.current.roots] });
      }, FLUSH_DELAY_MS);
    };

    source.onopen = () => {
      workingRef.current.connected = true;
      scheduleFlush();
    };
    source.onerror = () => {
      // EventSource retries the connection on its own; mark the gap so the UI
      // can fall back to interval polling while disconnected.
      workingRef.current.connected = false;
      scheduleFlush();
    };
    source.addEventListener('snapshot', (event) => {
      try {
        applySnapshot(workingRef.current, JSON.parse((event as MessageEvent<string>).data));
      } catch {
        return;
      }
      scheduleFlush();
    });
    for (const name of SCAN_EVENT_NAMES) {
      source.addEventListener(name, (event) => {
        let parsed: ScanEvent;
        try {
          parsed = JSON.parse((event as MessageEvent<string>).data) as ScanEvent;
        } catch {
          return;
        }
        const signal = applyEvent(workingRef.current, parsed);
        if (signal === 'finished') callbacksRef.current?.onScanFinished?.();
        if (signal === 'started') callbacksRef.current?.onScanStarted?.();
        scheduleFlush();
      });
    }

    return () => {
      disposed = true;
      if (flushTimerRef.current !== null) {
        clearTimeout(flushTimerRef.current);
        flushTimerRef.current = null;
      }
      source.close();
    };
  }, []);

  return state;
}

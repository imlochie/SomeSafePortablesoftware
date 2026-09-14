import { basename } from "node:path";

/**
 * Live archive scan observability.
 *
 * This module is a pure observability layer on top of the archive scanner in
 * services/archive.ts. It never changes scan, identity, reconciliation, or
 * storage semantics; the scanner notifies it at its existing internal
 * boundaries and this module maintains a small bounded in-memory picture of the
 * scan plus a subscriber fan-out for Server-Sent Events.
 *
 * The persisted archive_scan row (exposed through GET /api/archive/scan)
 * remains the source of truth for scan state. Everything here is ephemeral,
 * bounded, and safe to lose.
 */

export type ArchiveScanEventType =
  | "scan.started"
  | "scan.file.discovered"
  | "scan.file.started"
  | "scan.file.stage"
  | "scan.file.completed"
  | "scan.file.failed"
  | "scan.progress"
  | "scan.completed"
  | "scan.failed";

/**
 * Real per-file scanner stages. These map one-to-one onto the existing scanner
 * boundaries: the stat/unchanged check ("inspect"), the FFprobe media
 * inspection ("probe", skipped when a file is unchanged), and the SQLite
 * registration inside the batch transaction ("register"). No synthetic stages.
 */
export type ArchiveScanStageName = "inspect" | "probe" | "register";

export type ArchiveScanFileOutcome = "registered" | "unchanged" | "failed";

export type ArchiveScanMediaType = "movie" | "tv";

export type ArchiveScanEventBase = {
  sessionId: string;
  timestamp: string;
};

export type ArchiveScanEvent =
  | (ArchiveScanEventBase & { type: "scan.started"; roots: string[] })
  | (ArchiveScanEventBase & {
      type: "scan.file.discovered";
      path: string;
      filename: string;
      title: string;
      root: string | null;
      mediaType: ArchiveScanMediaType | null;
      discovered: number;
    })
  | (ArchiveScanEventBase & {
      type: "scan.file.started";
      path: string;
      filename: string;
      title: string;
      root: string | null;
      mediaType: ArchiveScanMediaType | null;
    })
  | (ArchiveScanEventBase & {
      type: "scan.file.stage";
      path: string;
      filename: string;
      stage: ArchiveScanStageName;
    })
  | (ArchiveScanEventBase & {
      type: "scan.file.completed";
      path: string;
      filename: string;
      outcome: Exclude<ArchiveScanFileOutcome, "failed">;
      scanned: number;
      failed: number;
      durationMs: number;
    })
  | (ArchiveScanEventBase & {
      type: "scan.file.failed";
      path: string;
      filename: string;
      error: string;
      scanned: number;
      failed: number;
    })
  | (ArchiveScanEventBase & {
      type: "scan.progress";
      scanned: number;
      failed: number;
      discovered: number;
      discoveryComplete: boolean;
    })
  | (ArchiveScanEventBase & {
      type: "scan.completed";
      scanned: number;
      failed: number;
      discovered: number;
      durationMs: number;
      lastError: string | null;
    })
  | (ArchiveScanEventBase & {
      type: "scan.failed";
      error: string;
      scanned: number;
      failed: number;
      discovered: number;
      durationMs: number;
    });

export type ArchiveScanStageView = {
  stage: ArchiveScanStageName;
  status: "active" | "done";
  at: string;
};

export type ArchiveScanActiveItemView = {
  path: string;
  filename: string;
  title: string;
  root: string | null;
  mediaType: ArchiveScanMediaType | null;
  startedAt: string;
  stages: ArchiveScanStageView[];
};

export type ArchiveScanRecentItemView = {
  path: string;
  filename: string;
  title: string;
  mediaType: ArchiveScanMediaType | null;
  outcome: ArchiveScanFileOutcome;
  error: string | null;
  completedAt: string;
  durationMs: number | null;
};

export type ArchiveScanLiveStateView = {
  sessionId: string | null;
  status: "idle" | "scanning" | "completed" | "failed";
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
  roots: string[];
  discovered: number;
  discoveryComplete: boolean;
  scanned: number;
  failed: number;
  activeCount: number;
  currentItem: ArchiveScanActiveItemView | null;
  activeItems: ArchiveScanActiveItemView[];
  recentItems: ArchiveScanRecentItemView[];
  lastError: string | null;
};

/** Bounded recent-item history surfaced to the UI and late SSE clients. */
const RECENT_ITEM_LIMIT = 20;
/**
 * Safety valve for in-flight files. The scanner's concurrency is capped at 8,
 * so this only matters if instrumentation is ever wired to a wider pipeline.
 */
const ACTIVE_ITEM_LIMIT = 32;

type ScanStageState = { stage: ArchiveScanStageName; status: "active" | "done"; at: string };

type ScanActiveItem = {
  path: string;
  filename: string;
  title: string;
  root: string | null;
  mediaType: ArchiveScanMediaType | null;
  startedAtMs: number;
  stages: ScanStageState[];
};

type ScanRecentItem = ArchiveScanRecentItemView;

type ScanLiveState = {
  sessionId: string | null;
  status: ArchiveScanLiveStateView["status"];
  startedAtMs: number | null;
  completedAt: string | null;
  roots: string[];
  discovered: number;
  discoveryComplete: boolean;
  scanned: number;
  failed: number;
  active: Map<string, ScanActiveItem>;
  /** Insertion-ordered oldest-first; the last entry is the most recently started file. */
  activeOrder: string[];
  recent: ScanRecentItem[];
  lastError: string | null;
};

type Subscriber = {
  ownerId: string;
  listener: (event: ArchiveScanEvent) => void;
};

const liveStates = new Map<string, ScanLiveState>();
const subscribers = new Set<Subscriber>();

function emptyState(): ScanLiveState {
  return {
    sessionId: null,
    status: "idle",
    startedAtMs: null,
    completedAt: null,
    roots: [],
    discovered: 0,
    discoveryComplete: false,
    scanned: 0,
    failed: 0,
    active: new Map(),
    activeOrder: [],
    recent: [],
    lastError: null,
  };
}

function stateFor(ownerId: string): ScanLiveState {
  let state = liveStates.get(ownerId);
  if (!state) {
    state = emptyState();
    liveStates.set(ownerId, state);
  }
  return state;
}

/**
 * Media type label for scan events. This mirrors the scanner's existing root
 * heuristic (see localIdentityFor in services/archive.ts) so the live view can
 * say "movie" or "tv" without re-running identity resolution.
 */
function mediaTypeForRoot(root: string | null | undefined): ArchiveScanMediaType | null {
  if (!root) return null;
  return /(^|[\\/])tv shows?([\\/]|$)/i.test(root) ? "tv" : "movie";
}

function titleForFilename(filename: string) {
  return filename.replace(/\.[^.]+$/, "");
}

function activeItemView(item: ScanActiveItem): ArchiveScanActiveItemView {
  return {
    path: item.path,
    filename: item.filename,
    title: item.title,
    root: item.root,
    mediaType: item.mediaType,
    startedAt: new Date(item.startedAtMs).toISOString(),
    stages: item.stages.map((stage) => ({ ...stage })),
  };
}

function toView(state: ScanLiveState): ArchiveScanLiveStateView {
  const activeItems = state.activeOrder
    .map((path) => state.active.get(path))
    .filter((item): item is ScanActiveItem => Boolean(item))
    .map(activeItemView);
  return {
    sessionId: state.sessionId,
    status: state.status,
    startedAt: state.startedAtMs === null ? null : new Date(state.startedAtMs).toISOString(),
    completedAt: state.completedAt,
    durationMs: state.startedAtMs === null
      ? null
      : (state.completedAt ? Date.parse(state.completedAt) : Date.now()) - state.startedAtMs,
    roots: [...state.roots],
    discovered: state.discovered,
    discoveryComplete: state.discoveryComplete,
    scanned: state.scanned,
    failed: state.failed,
    activeCount: state.active.size,
    currentItem: activeItems.length ? activeItems[activeItems.length - 1] : null,
    activeItems,
    // Internally recent history is append-order (oldest first, trimmed from the
    // front); the public view is newest first for direct UI rendering.
    recentItems: [...state.recent].reverse().map((item) => ({ ...item })),
    lastError: state.lastError,
  };
}

function emit(ownerId: string, event: ArchiveScanEvent) {
  for (const subscriber of subscribers) {
    if (subscriber.ownerId !== ownerId) continue;
    try {
      subscriber.listener(event);
    } catch {
      // A broken SSE client must never slow or break the scan itself.
    }
  }
}

function stageAt(stage: ArchiveScanStageName): ScanStageState {
  return { stage, status: "active", at: new Date().toISOString() };
}

function markStage(item: ScanActiveItem, stage: ArchiveScanStageName) {
  const existing = item.stages.find((entry) => entry.stage === stage);
  if (existing) {
    existing.status = "active";
    existing.at = new Date().toISOString();
    return;
  }
  // Earlier stages implicitly complete when a later boundary is reached.
  for (const entry of item.stages) entry.status = "done";
  item.stages.push(stageAt(stage));
}

function completeStages(item: ScanActiveItem) {
  for (const entry of item.stages) entry.status = "done";
}

function pushRecent(state: ScanLiveState, item: ScanRecentItem) {
  state.recent.push(item);
  if (state.recent.length > RECENT_ITEM_LIMIT) {
    state.recent.splice(0, state.recent.length - RECENT_ITEM_LIMIT);
  }
}

function finishActive(
  state: ScanLiveState,
  path: string,
  outcome: ArchiveScanFileOutcome,
  error: string | null,
): ScanRecentItem {
  const active = state.active.get(path);
  const now = new Date();
  const recent: ScanRecentItem = {
    path,
    filename: active?.filename ?? basename(path),
    title: active?.title ?? titleForFilename(basename(path)),
    mediaType: active?.mediaType ?? null,
    outcome,
    error,
    completedAt: now.toISOString(),
    durationMs: active ? now.getTime() - active.startedAtMs : null,
  };
  if (active) {
    completeStages(active);
    state.active.delete(path);
    state.activeOrder = state.activeOrder.filter((entry) => entry !== path);
  }
  pushRecent(state, recent);
  return recent;
}

// ---------------------------------------------------------------------------
// Scanner notifications (called from services/archive.ts)
// ---------------------------------------------------------------------------

export function notifyArchiveScanStarted(ownerId: string, sessionId: string, roots: string[]) {
  const state = stateFor(ownerId);
  state.sessionId = sessionId;
  state.status = "scanning";
  state.startedAtMs = Date.now();
  state.completedAt = null;
  state.roots = [...roots];
  state.discovered = 0;
  state.discoveryComplete = false;
  state.scanned = 0;
  state.failed = 0;
  state.active.clear();
  state.activeOrder = [];
  state.recent = [];
  state.lastError = null;
  emit(ownerId, { type: "scan.started", sessionId, timestamp: new Date().toISOString(), roots: [...roots] });
}

export function notifyArchiveScanFileDiscovered(
  ownerId: string,
  sessionId: string,
  filePath: string,
  root: string,
) {
  const state = stateFor(ownerId);
  state.discovered += 1;
  const filename = basename(filePath);
  emit(ownerId, {
    type: "scan.file.discovered",
    sessionId,
    timestamp: new Date().toISOString(),
    path: filePath,
    filename,
    title: titleForFilename(filename),
    root,
    mediaType: mediaTypeForRoot(root),
    discovered: state.discovered,
  });
}

export function notifyArchiveScanFileStarted(
  ownerId: string,
  sessionId: string,
  filePath: string,
  root: string,
) {
  const state = stateFor(ownerId);
  const filename = basename(filePath);
  const item: ScanActiveItem = {
    path: filePath,
    filename,
    title: titleForFilename(filename),
    root,
    mediaType: mediaTypeForRoot(root),
    startedAtMs: Date.now(),
    stages: [{ stage: "inspect", status: "active", at: new Date().toISOString() }],
  };
  if (!state.active.has(filePath)) {
    state.activeOrder.push(filePath);
    if (state.activeOrder.length > ACTIVE_ITEM_LIMIT) {
      const dropped = state.activeOrder.shift();
      if (dropped) state.active.delete(dropped);
    }
  }
  state.active.set(filePath, item);
  emit(ownerId, {
    type: "scan.file.started",
    sessionId,
    timestamp: new Date().toISOString(),
    path: filePath,
    filename,
    title: item.title,
    root,
    mediaType: item.mediaType,
  });
}

export function notifyArchiveScanFileStage(
  ownerId: string,
  sessionId: string,
  filePath: string,
  stage: ArchiveScanStageName,
) {
  const state = stateFor(ownerId);
  const active = state.active.get(filePath);
  if (active) markStage(active, stage);
  emit(ownerId, {
    type: "scan.file.stage",
    sessionId,
    timestamp: new Date().toISOString(),
    path: filePath,
    filename: active?.filename ?? basename(filePath),
    stage,
  });
}

export function notifyArchiveScanFileCompleted(
  ownerId: string,
  sessionId: string,
  filePath: string,
  outcome: "registered" | "unchanged",
  scanned: number,
  failed: number,
) {
  const state = stateFor(ownerId);
  state.scanned = Math.max(state.scanned, scanned);
  state.failed = Math.max(state.failed, failed);
  const recent = finishActive(state, filePath, outcome, null);
  emit(ownerId, {
    type: "scan.file.completed",
    sessionId,
    timestamp: recent.completedAt,
    path: filePath,
    filename: recent.filename,
    outcome,
    scanned: state.scanned,
    failed: state.failed,
    durationMs: recent.durationMs ?? 0,
  });
}

export function notifyArchiveScanFileFailed(
  ownerId: string,
  sessionId: string,
  filePath: string,
  error: string,
  scanned: number,
  failed: number,
) {
  const state = stateFor(ownerId);
  state.scanned = Math.max(state.scanned, scanned);
  state.failed = Math.max(state.failed, failed);
  const recent = finishActive(state, filePath, "failed", error);
  emit(ownerId, {
    type: "scan.file.failed",
    sessionId,
    timestamp: recent.completedAt,
    path: filePath,
    filename: recent.filename,
    error,
    scanned: state.scanned,
    failed: state.failed,
  });
}

export function notifyArchiveScanProgress(
  ownerId: string,
  sessionId: string,
  scanned: number,
  failed: number,
  discoveryComplete = false,
) {
  const state = stateFor(ownerId);
  state.scanned = Math.max(state.scanned, scanned);
  state.failed = Math.max(state.failed, failed);
  if (discoveryComplete) state.discoveryComplete = true;
  emit(ownerId, {
    type: "scan.progress",
    sessionId,
    timestamp: new Date().toISOString(),
    scanned: state.scanned,
    failed: state.failed,
    discovered: state.discovered,
    discoveryComplete: state.discoveryComplete,
  });
}

export function notifyArchiveScanCompleted(
  ownerId: string,
  sessionId: string,
  scanned: number,
  failed: number,
  lastError: string | null,
) {
  const state = stateFor(ownerId);
  state.status = "completed";
  state.completedAt = new Date().toISOString();
  state.discoveryComplete = true;
  state.scanned = Math.max(state.scanned, scanned);
  state.failed = Math.max(state.failed, failed);
  state.lastError = lastError;
  emit(ownerId, {
    type: "scan.completed",
    sessionId,
    timestamp: state.completedAt,
    scanned: state.scanned,
    failed: state.failed,
    discovered: state.discovered,
    durationMs: state.startedAtMs === null ? 0 : Date.parse(state.completedAt) - state.startedAtMs,
    lastError,
  });
}

export function notifyArchiveScanFailed(
  ownerId: string,
  sessionId: string | null,
  error: string,
  scanned?: number,
  failed?: number,
) {
  const state = stateFor(ownerId);
  state.status = "failed";
  state.completedAt = new Date().toISOString();
  state.discoveryComplete = true;
  state.lastError = error;
  if (typeof scanned === "number") state.scanned = Math.max(state.scanned, scanned);
  if (typeof failed === "number") state.failed = Math.max(state.failed, failed);
  const effectiveSessionId = sessionId ?? state.sessionId;
  if (!effectiveSessionId) return;
  emit(ownerId, {
    type: "scan.failed",
    sessionId: effectiveSessionId,
    timestamp: state.completedAt,
    error,
    scanned: state.scanned,
    failed: state.failed,
    discovered: state.discovered,
    durationMs: state.startedAtMs === null ? 0 : Date.parse(state.completedAt) - state.startedAtMs,
  });
}

// ---------------------------------------------------------------------------
// Reads and subscriptions (used by the SSE route and tests)
// ---------------------------------------------------------------------------

export function subscribeArchiveScanEvents(ownerId: string, listener: (event: ArchiveScanEvent) => void) {
  const subscription: Subscriber = { ownerId, listener };
  subscribers.add(subscription);
  return () => subscribers.delete(subscription);
}

export function readArchiveScanLiveState(ownerId: string): ArchiveScanLiveStateView {
  return toView(stateFor(ownerId));
}

/**
 * Number of live SSE subscriptions. Exposed so tests can prove that a
 * disconnecting browser actually releases its subscription: a leak here would
 * accumulate a dead listener (and its heartbeat timer) on every reconnect,
 * which is invisible in ordinary event assertions.
 */
export function archiveScanSubscriberCount() {
  return subscribers.size;
}

/** Test helper: drop all in-memory scan state and subscriptions. */
export function resetArchiveScanEventState() {
  liveStates.clear();
  subscribers.clear();
}

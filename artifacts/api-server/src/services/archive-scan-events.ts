import { randomUUID } from "node:crypto";

export type ArchiveScanStage = "discovering" | "inspecting" | "inspected" | "registering" | "completed" | "failed";
export type ArchiveScanEventType =
  | "scan.started"
  | "scan.file.discovered"
  | "scan.file.started"
  | "scan.file.stage"
  | "scan.file.completed"
  | "scan.file.failed"
  | "scan.progress"
  | "scan.completed";

export type ArchiveScanItem = {
  path: string;
  title: string;
  mediaType: "movie" | "tv";
  stage: ArchiveScanStage;
  status: "active" | "completed" | "failed";
  error?: string;
};

export type ArchiveScanEvent = {
  id: string;
  type: ArchiveScanEventType;
  scanId: string;
  timestamp: string;
  scannedCount: number;
  discoveredCount: number;
  totalCount: number | null;
  item?: ArchiveScanItem;
  stage?: ArchiveScanStage;
  status?: "scanning" | "completed" | "failed";
  error?: string;
};

export type ArchiveScanSnapshot = {
  type: "scan.snapshot";
  scanId: string | null;
  timestamp: string;
  status: "not_scanned" | "scanning" | "completed" | "failed";
  startedAt: string | null;
  completedAt: string | null;
  scannedCount: number;
  discoveredCount: number;
  totalCount: number | null;
  currentItem: ArchiveScanItem | null;
  recentItems: ArchiveScanItem[];
};

type Listener = (event: ArchiveScanEvent) => void;
type LiveState = Omit<ArchiveScanSnapshot, "type" | "timestamp"> & { recentItems: ArchiveScanItem[] };
const states = new Map<string, LiveState>();
const listeners = new Map<string, Set<Listener>>();
const RECENT_LIMIT = 20;

function titleFromPath(path: string) {
  const filename = path.replaceAll("\\", "/").split("/").at(-1) ?? path;
  return filename.replace(/\.[^.]+$/, "");
}
function mediaType(path: string): "movie" | "tv" {
  return /(^|[\\/])tv shows?([\\/]|$)/i.test(path) || /\bS\d{1,2}E\d{1,3}\b/i.test(path) ? "tv" : "movie";
}
function item(path: string, stage: ArchiveScanStage, status: ArchiveScanItem["status"], error?: string): ArchiveScanItem {
  return { path, title: titleFromPath(path), mediaType: mediaType(path), stage, status, ...(error ? { error } : {}) };
}

export function beginArchiveScanEvents(ownerId: string) {
  const now = new Date().toISOString();
  const state: LiveState = {
    scanId: randomUUID(), status: "scanning", startedAt: now, completedAt: null,
    scannedCount: 0, discoveredCount: 0, totalCount: null, currentItem: null, recentItems: [],
  };
  states.set(ownerId, state);
  publish(ownerId, "scan.started", { status: "scanning" });
  return state.scanId!;
}

export function publishArchiveScanEvent(ownerId: string, type: ArchiveScanEventType, details: Partial<Omit<ArchiveScanEvent, "id" | "type" | "scanId" | "timestamp">> = {}) {
  publish(ownerId, type, details);
}

function publish(ownerId: string, type: ArchiveScanEventType, details: Partial<Omit<ArchiveScanEvent, "id" | "type" | "scanId" | "timestamp">>) {
  const state = states.get(ownerId);
  if (!state?.scanId) return;
  if (details.discoveredCount !== undefined) state.discoveredCount = details.discoveredCount;
  if (details.scannedCount !== undefined) state.scannedCount = details.scannedCount;
  if (details.totalCount !== undefined) state.totalCount = details.totalCount;
  if (details.item) {
    state.currentItem = details.item;
    if (type === "scan.file.completed" || type === "scan.file.failed") {
      state.recentItems = [details.item, ...state.recentItems].slice(0, RECENT_LIMIT);
    }
  }
  if (type === "scan.completed") {
    state.status = details.status === "failed" ? "failed" : "completed";
    state.completedAt = new Date().toISOString();
    state.currentItem = null;
  }
  const event: ArchiveScanEvent = {
    id: randomUUID(), type, scanId: state.scanId, timestamp: new Date().toISOString(),
    scannedCount: state.scannedCount, discoveredCount: state.discoveredCount, totalCount: state.totalCount,
    ...details,
  };
  for (const listener of listeners.get(ownerId) ?? []) queueMicrotask(() => listener(event));
}

export function scanItem(path: string, stage: ArchiveScanStage, status: ArchiveScanItem["status"], error?: string) {
  return item(path, stage, status, error);
}

export function readArchiveScanEventSnapshot(ownerId: string, fallback?: { status: ArchiveScanSnapshot["status"]; startedAt: string | null; completedAt: string | null; scannedFiles: number }) : ArchiveScanSnapshot {
  const state = states.get(ownerId);
  return state ? { type: "scan.snapshot", timestamp: new Date().toISOString(), ...state } : {
    type: "scan.snapshot", scanId: null, timestamp: new Date().toISOString(), status: fallback?.status ?? "not_scanned",
    startedAt: fallback?.startedAt ?? null, completedAt: fallback?.completedAt ?? null, scannedCount: fallback?.scannedFiles ?? 0,
    discoveredCount: fallback?.scannedFiles ?? 0, totalCount: null, currentItem: null, recentItems: [],
  };
}

export function formatArchiveScanSse(event: { id?: string; type: string }) {
  const id = event.id ? `id: ${event.id}\n` : "";
  return `${id}event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

export function subscribeArchiveScanEvents(ownerId: string, listener: Listener) {
  let ownerListeners = listeners.get(ownerId);
  if (!ownerListeners) listeners.set(ownerId, ownerListeners = new Set());
  ownerListeners.add(listener);
  return () => {
    ownerListeners!.delete(listener);
    if (!ownerListeners!.size) listeners.delete(ownerId);
  };
}

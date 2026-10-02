/**
 * Authoritative answer to "is a scan actually running right now?"
 *
 * Two independent sources report scan state and they have different lifetimes:
 *
 *   - The REST view (`GET /api/archive/scan`) is backed by a SQLite row. It
 *     survives restarts, which is exactly why it can be stale: a process that
 *     dies mid-scan leaves `status: "scanning"` behind with nothing running.
 *   - The live feed (SSE) is backed by an in-memory map in the API process. It
 *     cannot outlive the scan it describes, so it is never stale -- but it is
 *     only trustworthy while the stream is actually connected.
 *
 * The UI used to merge these with OR:
 *
 *     scan?.status === 'scanning' || scanEvents.status === 'scanning'
 *
 * which lets the stale source win permanently. The result was a screen showing
 * "SCANNING" in the toolbar and "start a scan to watch the pipeline" in the
 * panel at the same time, with the start button disabled forever.
 *
 * The rule here is narrower: a connected live feed is authoritative, because it
 * is the only source that can distinguish a running scan from a dead record. A
 * persisted `scanning` with a connected feed reporting no session is not a scan
 * in progress -- it is the residue of one that was interrupted.
 */

/** Status reported by the persisted REST scan record. */
export type PersistedScanStatus =
  | 'not_scanned'
  | 'scanning'
  /** Stopped before finishing; starting a scan continues that same pass. */
  | 'interrupted'
  | 'completed'
  | 'failed';

/** Status reported by the in-memory live scan feed. */
export type LiveScanStatus = 'idle' | 'scanning' | 'completed' | 'failed';

export interface ScanLifecycleInput {
  /** Persisted status, or undefined before the REST query resolves. */
  persistedStatus: PersistedScanStatus | undefined;
  /** Live feed status. */
  liveStatus: LiveScanStatus;
  /** Whether the SSE stream is currently connected. */
  liveConnected: boolean;
  /** Whether the live feed is tracking a session at all. */
  liveHasSession: boolean;
}

export type ScanLifecycle =
  /** No scan has ever run, or the last one finished cleanly. */
  | 'idle'
  /** A scan is genuinely running right now. */
  | 'scanning'
  /** A persisted scan never reached a terminal state; nothing is running. */
  | 'interrupted';

export function resolveScanLifecycle({
  persistedStatus,
  liveStatus,
  liveConnected,
  liveHasSession,
}: ScanLifecycleInput): ScanLifecycle {
  // The live feed observes the running scan directly. While it is connected it
  // is the only source that can be trusted about "now".
  // The API records interruption explicitly at startup now, so this no longer
  // has to be inferred from a stale `scanning`. The inference below is kept as
  // a safety net for a process that dies while the browser stays open.
  if (persistedStatus === 'interrupted' && liveStatus !== 'scanning') return 'interrupted';

  if (liveConnected) {
    if (liveStatus === 'scanning') return 'scanning';

    // Connected, and the feed knows of no running scan. A persisted `scanning`
    // therefore describes a scan that died rather than one in flight. Note the
    // session check: a feed that is mid-session but momentarily reporting a
    // non-scanning status is not evidence of interruption.
    if (persistedStatus === 'scanning' && !liveHasSession) return 'interrupted';

    return 'idle';
  }

  // The feed is down, so it proves nothing either way and the persisted record
  // is all there is. Trusting it here is deliberate: a scan really may be
  // running in the API process while the browser's stream is broken, and
  // falsely reporting idle would invite a second concurrent scan. Polling
  // covers this case, and reconciliation at API startup means the record
  // cannot stay wrong across a restart.
  if (persistedStatus === 'scanning') return 'scanning';

  return 'idle';
}

/** Convenience for the many call sites that only need the boolean. */
export function isActivelyScanning(input: ScanLifecycleInput): boolean {
  return resolveScanLifecycle(input) === 'scanning';
}

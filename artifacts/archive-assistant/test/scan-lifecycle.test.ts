import { describe, expect, it } from 'vitest';
import { resolveScanLifecycle, isActivelyScanning } from '../src/lib/scan-lifecycle';

/**
 * Scan lifecycle authority.
 *
 * The reported bug: the toolbar said SCANNING while the panel said "start a
 * scan to watch the pipeline", and the start button stayed disabled forever.
 * Both components were reading honestly from different sources. The persisted
 * REST record survives restarts and can be stale; the in-memory live feed
 * cannot be stale but is only meaningful while connected. Merging them with
 * OR let the stale source win permanently.
 */

describe('resolveScanLifecycle', () => {
  it('reports interrupted for the exact reproduced contradiction: REST scanning, SSE idle', () => {
    // This is the state captured from a real server: the persisted row said
    // `scanning` while the SSE snapshot from the same process said `idle`.
    expect(
      resolveScanLifecycle({
        persistedStatus: 'scanning',
        liveStatus: 'idle',
        liveConnected: true,
        liveHasSession: false,
      }),
    ).toBe('interrupted');
  });

  it('does not report scanning for that contradiction, which is what disabled the button', () => {
    const input = {
      persistedStatus: 'scanning' as const,
      liveStatus: 'idle' as const,
      liveConnected: true,
      liveHasSession: false,
    };
    expect(isActivelyScanning(input)).toBe(false);
  });

  it('reports scanning when the live feed actually observes a scan', () => {
    expect(
      resolveScanLifecycle({
        persistedStatus: 'scanning',
        liveStatus: 'scanning',
        liveConnected: true,
        liveHasSession: true,
      }),
    ).toBe('scanning');
  });

  it('trusts the live feed even before the persisted record catches up', () => {
    // A scan that has just started is visible on the feed before the REST
    // query refetches. The UI must react immediately, not a poll later.
    expect(
      resolveScanLifecycle({
        persistedStatus: 'completed',
        liveStatus: 'scanning',
        liveConnected: true,
        liveHasSession: true,
      }),
    ).toBe('scanning');
  });

  it('falls back to the persisted record when the feed is disconnected', () => {
    // With no feed there is no better source, and claiming idle could invite a
    // second concurrent scan against a scan that really is running.
    expect(
      resolveScanLifecycle({
        persistedStatus: 'scanning',
        liveStatus: 'idle',
        liveConnected: false,
        liveHasSession: false,
      }),
    ).toBe('scanning');
  });

  it('does not call a disconnected, never-scanned state anything but idle', () => {
    expect(
      resolveScanLifecycle({
        persistedStatus: 'not_scanned',
        liveStatus: 'idle',
        liveConnected: false,
        liveHasSession: false,
      }),
    ).toBe('idle');
  });

  it('treats a finished scan as idle rather than interrupted', () => {
    for (const persistedStatus of ['completed', 'failed', 'not_scanned'] as const) {
      expect(
        resolveScanLifecycle({
          persistedStatus,
          liveStatus: 'idle',
          liveConnected: true,
          liveHasSession: false,
        }),
      ).toBe('idle');
    }
  });

  it('does not declare interruption while the feed still holds a session', () => {
    // A feed mid-session that momentarily reports completed is finishing up,
    // not interrupted. Declaring interruption here would flash a false warning
    // at the end of every successful scan.
    expect(
      resolveScanLifecycle({
        persistedStatus: 'scanning',
        liveStatus: 'completed',
        liveConnected: true,
        liveHasSession: true,
      }),
    ).toBe('idle');
  });

  it('handles the persisted record being undefined before the query resolves', () => {
    expect(
      resolveScanLifecycle({
        persistedStatus: undefined,
        liveStatus: 'idle',
        liveConnected: true,
        liveHasSession: false,
      }),
    ).toBe('idle');
    expect(
      resolveScanLifecycle({
        persistedStatus: undefined,
        liveStatus: 'scanning',
        liveConnected: true,
        liveHasSession: true,
      }),
    ).toBe('scanning');
  });

  it('recovers to idle after reconciliation rewrites the record', () => {
    // The post-reconciliation state the operator should land in: persisted
    // terminal, live idle, UI not scanning, new scan startable.
    const afterReconciliation = resolveScanLifecycle({
      persistedStatus: 'failed',
      liveStatus: 'idle',
      liveConnected: true,
      liveHasSession: false,
    });
    expect(afterReconciliation).toBe('idle');
    expect(afterReconciliation).not.toBe('interrupted');
  });
});

/**
 * Resumable scanning, UI side.
 *
 * The API now records an interrupted pass explicitly rather than leaving a
 * stale `scanning` behind, and starting a scan continues that pass.
 */
describe('resolveScanLifecycle with explicit interruption', () => {
  it('reports interrupted when the API says so', () => {
    expect(
      resolveScanLifecycle({
        persistedStatus: 'interrupted',
        liveStatus: 'idle',
        liveConnected: true,
        liveHasSession: false,
      }),
    ).toBe('interrupted');
  });

  it('reports interrupted even when the live feed is disconnected', () => {
    // The old inference needed a connected feed to distinguish stale from
    // running. An explicit `interrupted` needs no such evidence.
    expect(
      resolveScanLifecycle({
        persistedStatus: 'interrupted',
        liveStatus: 'idle',
        liveConnected: false,
        liveHasSession: false,
      }),
    ).toBe('interrupted');
  });

  it('stops reporting interrupted once the resumed scan is running', () => {
    // The persisted row still reads `interrupted` until the resumed pass
    // writes `scanning`, so the live feed must win here or the banner would
    // linger over a scan that is visibly running.
    expect(
      resolveScanLifecycle({
        persistedStatus: 'interrupted',
        liveStatus: 'scanning',
        liveConnected: true,
        liveHasSession: true,
      }),
    ).toBe('scanning');
  });

  it('still catches a stale scanning record as interrupted', () => {
    // Safety net for a process that dies while the browser stays open, before
    // startup reconciliation has had a chance to run.
    expect(
      resolveScanLifecycle({
        persistedStatus: 'scanning',
        liveStatus: 'idle',
        liveConnected: true,
        liveHasSession: false,
      }),
    ).toBe('interrupted');
  });
});

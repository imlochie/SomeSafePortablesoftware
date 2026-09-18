import { archiveDb } from "../lib/archive-db";

export const providerNames = ["plex", "jellyfin"] as const;
export type ProviderName = (typeof providerNames)[number];

type RefreshRow = {
  refresh_id: string;
  owner_id: string;
  provider: ProviderName;
  started_at: string;
  completed_at: string | null;
  status: string;
  snapshot_completeness: string;
  item_count: number | null;
  authoritative: number;
  reason: string | null;
  snapshot_reference: string | null;
};

export function validateProviderRefreshSemantics(input: {
  status: string;
  snapshotCompleteness: string;
  authoritative: boolean;
}) {
  const valid = (input.status === "synced" && input.snapshotCompleteness === "complete")
    || (input.status === "sync_error" && ["partial", "unknown"].includes(input.snapshotCompleteness) && !input.authoritative)
    || (input.status === "syncing" && input.snapshotCompleteness === "unknown" && !input.authoritative);
  if (!valid) throw new Error("Provider refresh status, completeness, and authority are inconsistent.");
}

function mapRefresh(row: RefreshRow) {
  const authoritative = row.authoritative === 1;
  validateProviderRefreshSemantics({ status: row.status, snapshotCompleteness: row.snapshot_completeness, authoritative });
  return {
    refreshId: row.refresh_id,
    provider: row.provider,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    status: row.status,
    snapshotCompleteness: row.snapshot_completeness,
    itemCount: row.item_count,
    authoritative,
    reason: row.reason,
    snapshotReference: row.snapshot_reference,
  };
}

export function readProviderRefreshHistory(ownerId: string, provider: ProviderName, page = 1, pageSize = 25) {
  const safePage = Math.max(1, Math.floor(page));
  const safePageSize = Math.min(100, Math.max(1, Math.floor(pageSize)));
  const total = (archiveDb.prepare(
    "SELECT COUNT(*) AS count FROM provider_refresh WHERE owner_id = ? AND provider = ?",
  ).get(ownerId, provider) as { count: number }).count;
  const rows = archiveDb.prepare(`
    SELECT refresh_id, owner_id, provider, started_at, completed_at, status,
           snapshot_completeness, item_count, authoritative, reason, snapshot_reference
    FROM provider_refresh
    WHERE owner_id = ? AND provider = ?
    ORDER BY started_at DESC, refresh_id DESC
    LIMIT ? OFFSET ?
  `).all(ownerId, provider, safePageSize, (safePage - 1) * safePageSize) as RefreshRow[];
  return {
    results: rows.map(mapRefresh),
    pagination: { page: safePage, pageSize: safePageSize, total, totalPages: Math.ceil(total / safePageSize) },
  };
}

export function readProviderRefreshState(ownerId: string, provider: ProviderName) {
  const latest = archiveDb.prepare(`
    SELECT refresh_id, owner_id, provider, started_at, completed_at, status,
           snapshot_completeness, item_count, authoritative, reason, snapshot_reference
    FROM provider_refresh
    WHERE owner_id = ? AND provider = ?
    ORDER BY started_at DESC, refresh_id DESC LIMIT 1
  `).get(ownerId, provider) as RefreshRow | undefined;
  const successful = archiveDb.prepare(`
    SELECT refresh_id, owner_id, provider, started_at, completed_at, status,
           snapshot_completeness, item_count, authoritative, reason, snapshot_reference
    FROM provider_refresh
    WHERE owner_id = ? AND provider = ? AND status = 'synced'
    ORDER BY completed_at DESC, refresh_id DESC LIMIT 1
  `).get(ownerId, provider) as RefreshRow | undefined;
  const authoritative = archiveDb.prepare(`
    SELECT refresh_id, owner_id, provider, started_at, completed_at, status,
           snapshot_completeness, item_count, authoritative, reason, snapshot_reference
    FROM provider_refresh
    WHERE owner_id = ? AND provider = ? AND authoritative = 1
    ORDER BY completed_at DESC, refresh_id DESC LIMIT 1
  `).get(ownerId, provider) as RefreshRow | undefined;
  return {
    provider,
    lastAttemptedRefresh: latest ? mapRefresh(latest) : null,
    lastSuccessfulRefresh: successful ? mapRefresh(successful) : null,
    currentAuthoritativeRefresh: authoritative ? mapRefresh(authoritative) : null,
  };
}

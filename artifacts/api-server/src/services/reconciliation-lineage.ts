import { archiveDb } from "../lib/archive-db";
import { readReviewItem } from "./review-queue";

export function readReconciliationFindingLineage(ownerId: string, reviewItemId: number) {
  const finding = readReviewItem(reviewItemId, ownerId);
  if (!finding || finding.kind !== "archive_finding") return null;
  const current = archiveDb.prepare(`
    SELECT id, evidence_key, observed_at, payload_json
    FROM review_item_observation
    WHERE owner_id = ? AND review_item_id = ? AND status = 'active'
    ORDER BY id DESC LIMIT 1
  `).get(ownerId, reviewItemId) as { id: number; evidence_key: string; observed_at: string; payload_json: string } | undefined;
  const previous = archiveDb.prepare(`
    SELECT id, evidence_key, observed_at, payload_json
    FROM review_item_observation
    WHERE owner_id = ? AND review_item_id = ? AND status = 'superseded'
    ORDER BY id DESC LIMIT 1
  `).get(ownerId, reviewItemId) as { id: number; evidence_key: string; observed_at: string; payload_json: string } | undefined;
  const payload = finding.payload;
  const snapshot = payload.snapshot && typeof payload.snapshot === "object" ? payload.snapshot as Record<string, unknown> : null;
  const refresh = snapshot?.refreshId && typeof snapshot.provider === "string"
    ? archiveDb.prepare(`
        SELECT snapshot_reference FROM provider_refresh
        WHERE owner_id = ? AND provider = ? AND refresh_id = ?
      `).get(ownerId, snapshot.provider, snapshot.refreshId) as { snapshot_reference: string | null } | undefined
    : undefined;
  return {
    finding: {
      reviewItemId: finding.id,
      subjectKey: finding.subjectKey,
      state: finding.state,
      classification: typeof payload.classification === "string" ? payload.classification : null,
      title: finding.title,
      evidenceKey: typeof payload.evidenceKey === "string" ? payload.evidenceKey : null,
    },
    currentObservation: current ? {
      observationId: current.id,
      evidenceKey: current.evidence_key,
      observedAt: current.observed_at,
    } : null,
    provider: snapshot ? {
      provider: typeof snapshot.provider === "string" ? snapshot.provider : null,
      refreshId: typeof snapshot.refreshId === "string" ? snapshot.refreshId : null,
      capturedAt: typeof snapshot.capturedAt === "string" ? snapshot.capturedAt : null,
      snapshotReference: refresh?.snapshot_reference ?? null,
    } : null,
    previousObservation: previous ? {
      observationId: previous.id,
      evidenceKey: previous.evidence_key,
      observedAt: previous.observed_at,
    } : null,
  };
}

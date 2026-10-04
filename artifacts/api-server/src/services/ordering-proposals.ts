import { createHash, randomUUID } from "node:crypto";
import { archiveDb, readSettings } from "../lib/archive-db";
import { isPathWithin } from "./media";
import { ensureReviewItem, readReviewItem, type ReviewItem } from "./review-queue";

export type OrderingProposalMapping = {
  mappingId: string;
  originalPath: string;
  proposedPath: string;
  currentEpisode: number | null;
  proposedEpisode: number | null;
  expectedSourceIdentity: string;
  expectedSourceState?: Record<string, unknown>;
};

export type OrderingProposalSnapshot = {
  proposalId: string;
  reviewItemId: number;
  ownerId: string;
  collectionId: string;
  proposalVersion: string;
  createdAt: string;
  hypothesis: string;
  confidence: string;
  evidence: string[];
  unknowns: string[];
  sourceMappings: OrderingProposalMapping[];
  expectedCollectionMembership: string[];
  expectedSourceState: Record<string, unknown>;
  expectedDestinationState: Record<string, unknown>;
};

function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return item;
    return Object.fromEntries(Object.entries(item).sort(([left], [right]) => left.localeCompare(right)));
  });
}

function hash(value: unknown) {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

function snapshotFromRow(row: Record<string, unknown>): OrderingProposalSnapshot {
  return JSON.parse(String(row.snapshot_json)) as OrderingProposalSnapshot;
}

export function createOrderingProposalSnapshot(
  ownerId: string,
  input: Omit<OrderingProposalSnapshot, "proposalId" | "reviewItemId" | "ownerId" | "proposalVersion" | "createdAt"> & { proposalId?: string },
): { snapshot: OrderingProposalSnapshot; review: ReviewItem } {
  if (!ownerId.trim() || !input.collectionId.trim()) throw new Error("Owner and collection identity are required.");
  if (!input.sourceMappings.length) throw new Error("An ordering proposal must contain at least one mapping.");
  const mappingIds = new Set<string>();
  const membership = new Set(input.expectedCollectionMembership);
  for (const mapping of input.sourceMappings) {
    if (!mapping.mappingId || mappingIds.has(mapping.mappingId)) throw new Error("Ordering proposal mapping IDs must be unique.");
    if (!mapping.expectedSourceIdentity) throw new Error(`Mapping ${mapping.mappingId} has no expected source identity.`);
    if (!membership.has(mapping.originalPath)) throw new Error(`Mapping ${mapping.mappingId} is outside the expected collection membership.`);
    mappingIds.add(mapping.mappingId);
  }
  const proposalBody = { ...input, ownerId, proposalId: input.proposalId ?? undefined };
  const proposalVersion = hash(proposalBody);
  const proposalId = input.proposalId ?? `ordering-${proposalVersion.slice(0, 24)}`;
  const existing = archiveDb.prepare("SELECT * FROM ordering_proposal WHERE owner_id = ? AND proposal_id = ?").get(ownerId, proposalId) as Record<string, unknown> | undefined;
  if (existing) {
    const existingSnapshot = snapshotFromRow(existing);
    if (existingSnapshot.proposalVersion !== proposalVersion) throw new Error("An immutable ordering proposal already exists with this identity.");
    const review = readReviewItem(Number(existing.review_item_id), ownerId);
    if (!review) throw new Error("The ordering proposal review item is missing.");
    return { snapshot: existingSnapshot, review };
  }
  const createdAt = new Date().toISOString();
  const snapshotBase = { ...input, proposalId, ownerId, proposalVersion, createdAt };
  const review = ensureReviewItem(ownerId, {
    kind: "naming_proposal",
    subjectKey: proposalId,
    title: "Review intelligent episode ordering",
    payload: snapshotBase,
  });
  const snapshot = { ...snapshotBase, reviewItemId: review.id } as OrderingProposalSnapshot;
  archiveDb.prepare(`INSERT INTO ordering_proposal
    (proposal_id, owner_id, review_item_id, collection_id, proposal_version, snapshot_json)
    VALUES (?, ?, ?, ?, ?, ?)`)
    .run(proposalId, ownerId, review.id, input.collectionId, proposalVersion, JSON.stringify(snapshot));
  return { snapshot, review };
}

export function readOrderingProposal(ownerId: string, proposalId: string) {
  const row = archiveDb.prepare("SELECT * FROM ordering_proposal WHERE owner_id = ? AND proposal_id = ?").get(ownerId, proposalId) as Record<string, unknown> | undefined;
  return row ? snapshotFromRow(row) : null;
}

export function currentOrderingProposalValidation(ownerId: string, proposalId: string) {
  const snapshot = readOrderingProposal(ownerId, proposalId);
  if (!snapshot) return { state: "UNKNOWN" as const, reasons: ["Proposal not found."] };
  const paths = snapshot.expectedCollectionMembership;
  const rows = archiveDb.prepare(`SELECT id, path, size_bytes, checksum, fingerprint, scan_status
    FROM file_record WHERE owner_id = ? AND path IN (${paths.map(() => "?").join(",")})`).all(ownerId, ...paths) as Array<Record<string, unknown>>;
  const byPath = new Map(rows.map((row) => [String(row.path), row]));
  const reasons: string[] = [];
  if (rows.length !== paths.length) reasons.push(`Collection membership changed: expected ${paths.length}, found ${rows.length}.`);
  for (const mapping of snapshot.sourceMappings) {
    const row = byPath.get(mapping.originalPath);
    if (!row || row.scan_status !== "active") { reasons.push(`Source is unavailable: ${mapping.originalPath}`); continue; }
    const currentIdentity = `file_record:${row.id}:${row.checksum ?? row.fingerprint ?? row.size_bytes ?? "unknown"}`;
    if (mapping.expectedSourceIdentity !== currentIdentity) reasons.push(`Source identity changed: ${mapping.originalPath}`);
  }
  const settings = readSettings();
  for (const mapping of snapshot.sourceMappings) {
    if (!settings.archiveDirectory || !isPathWithin(mapping.proposedPath, settings.archiveDirectory)) reasons.push(`Destination is outside the configured archive: ${mapping.proposedPath}`);
    const occupant = archiveDb.prepare("SELECT id FROM file_record WHERE owner_id = ? AND path = ? AND scan_status = 'active'").get(ownerId, mapping.proposedPath);
    if (occupant && !paths.includes(mapping.proposedPath)) reasons.push(`Destination is occupied: ${mapping.proposedPath}`);
  }
  return reasons.length ? { state: "STALE" as const, reasons } : { state: "CURRENT" as const, reasons: [] };
}

export function validateOrderingProposal(
  ownerId: string,
  proposalId: string,
  current: { membership: string[]; sourceIdentities: Record<string, string>; destinations: string[] },
): { ok: true; snapshot: OrderingProposalSnapshot } | { ok: false; code: "STALE_PROPOSAL" | "UNSAFE_TO_EXECUTE"; reasons: string[] } {
  const snapshot = readOrderingProposal(ownerId, proposalId);
  if (!snapshot) return { ok: false, code: "UNSAFE_TO_EXECUTE", reasons: ["The ordering proposal does not exist for this owner."] };
  const reasons: string[] = [];
  if (canonical([...current.membership].sort()) !== canonical([...snapshot.expectedCollectionMembership].sort())) reasons.push("Collection membership changed.");
  for (const mapping of snapshot.sourceMappings) {
    if (current.sourceIdentities[mapping.originalPath] !== mapping.expectedSourceIdentity) reasons.push(`Source identity changed: ${mapping.originalPath}`);
  }
  const currentDestinations = new Set(current.destinations);
  for (const mapping of snapshot.sourceMappings) if (currentDestinations.has(mapping.proposedPath) && !current.membership.includes(mapping.proposedPath)) reasons.push(`Destination is no longer safe: ${mapping.proposedPath}`);
  return reasons.length ? { ok: false, code: "STALE_PROPOSAL", reasons } : { ok: true, snapshot };
}

import { archiveDb, addEvent } from "../lib/archive-db";

export const reviewItemKinds = [
  "acquisition_recommendation",
  "naming_proposal",
  "archive_finding",
  "operation_approval",
] as const;
export type ReviewItemKind = (typeof reviewItemKinds)[number];

export const reviewItemStates = [
  "pending",
  "approved",
  "rejected",
  "deferred",
  "reopened",
] as const;
export type ReviewItemState = (typeof reviewItemStates)[number];

export interface ReviewItemDecision {
  id: number;
  fromState: ReviewItemState | null;
  toState: ReviewItemState;
  note: string | null;
  decidedBy: string | null;
  createdAt: string;
}

export interface ReviewItem {
  id: number;
  kind: ReviewItemKind;
  subjectKey: string;
  title: string;
  state: ReviewItemState;
  payload: Record<string, unknown>;
  note: string | null;
  decisionAt: string | null;
  decidedBy: string | null;
  createdAt: string;
  updatedAt: string;
  decisions: ReviewItemDecision[];
}

const transitions: Record<ReviewItemState, readonly ReviewItemState[]> = {
  pending: ["approved", "rejected", "deferred"],
  approved: ["reopened"],
  rejected: ["reopened"],
  deferred: ["reopened"],
  reopened: ["approved", "rejected", "deferred"],
};

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function json(value: unknown): Record<string, unknown> {
  try {
    return record(JSON.parse(String(value ?? "{}")));
  } catch {
    return {};
  }
}

function state(value: unknown): ReviewItemState {
  if (typeof value === "string" && reviewItemStates.includes(value as ReviewItemState)) {
    return value as ReviewItemState;
  }
  return "pending";
}

function kind(value: unknown): ReviewItemKind {
  if (typeof value === "string" && reviewItemKinds.includes(value as ReviewItemKind)) {
    return value as ReviewItemKind;
  }
  throw new Error("Review item kind is not supported.");
}

function readDecisions(id: number, ownerId: string): ReviewItemDecision[] {
  return (archiveDb.prepare(`
    SELECT id, from_state, to_state, note, decided_by, created_at
    FROM review_item_decision
    WHERE review_item_id = ? AND owner_id = ?
    ORDER BY created_at ASC, id ASC
  `).all(id, ownerId) as Array<Record<string, unknown>>).map((row) => ({
    id: Number(row.id),
    fromState: row.from_state == null ? null : state(row.from_state),
    toState: state(row.to_state),
    note: row.note == null ? null : String(row.note),
    decidedBy: row.decided_by == null ? null : String(row.decided_by),
    createdAt: String(row.created_at),
  }));
}

function mapItem(row: Record<string, unknown>, ownerId: string): ReviewItem {
  const id = Number(row.id);
  return {
    id,
    kind: kind(row.kind),
    subjectKey: String(row.subject_key),
    title: String(row.title),
    state: state(row.state),
    payload: json(row.payload_json),
    note: row.note == null ? null : String(row.note),
    decisionAt: row.decision_at == null ? null : String(row.decision_at),
    decidedBy: row.decided_by == null ? null : String(row.decided_by),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    decisions: readDecisions(id, ownerId),
  };
}

export function readReviewItem(id: number, ownerId: string): ReviewItem | null {
  const row = archiveDb.prepare(
    "SELECT * FROM review_item WHERE id = ? AND owner_id = ?",
  ).get(id, ownerId) as Record<string, unknown> | undefined;
  return row ? mapItem(row, ownerId) : null;
}

export function listReviewItems(
  ownerId: string,
  filters: { state?: ReviewItemState; kind?: ReviewItemKind } = {},
): ReviewItem[] {
  const conditions = ["owner_id = ?"];
  const values: Array<string> = [ownerId];
  if (filters.state) {
    conditions.push("state = ?");
    values.push(filters.state);
  }
  if (filters.kind) {
    conditions.push("kind = ?");
    values.push(filters.kind);
  }
  return (archiveDb.prepare(`
    SELECT * FROM review_item
    WHERE ${conditions.join(" AND ")}
    ORDER BY
      CASE state WHEN 'pending' THEN 0 WHEN 'reopened' THEN 1 WHEN 'deferred' THEN 2 ELSE 3 END,
      updated_at DESC, id DESC
  `).all(...values) as Array<Record<string, unknown>>).map((row) => mapItem(row, ownerId));
}

export function ensureReviewItem(
  ownerId: string,
  input: {
    kind: ReviewItemKind;
    subjectKey: string;
    title: string;
    payload?: Record<string, unknown>;
  },
): ReviewItem {
  if (!ownerId.trim()) throw new Error("A review owner is required.");
  if (!input.subjectKey.trim()) throw new Error("A review subject key is required.");
  if (!input.title.trim()) throw new Error("A review title is required.");
  archiveDb.prepare(`
    INSERT INTO review_item
      (owner_id, kind, subject_key, title, state, payload_json)
    VALUES (?, ?, ?, ?, 'pending', ?)
    ON CONFLICT(owner_id, kind, subject_key) DO UPDATE SET
      title = excluded.title,
      payload_json = excluded.payload_json,
      updated_at = CURRENT_TIMESTAMP
  `).run(ownerId, input.kind, input.subjectKey, input.title, JSON.stringify(input.payload ?? {}));
  const row = archiveDb.prepare(`
    SELECT * FROM review_item
    WHERE owner_id = ? AND kind = ? AND subject_key = ?
  `).get(ownerId, input.kind, input.subjectKey) as Record<string, unknown>;
  return mapItem(row, ownerId);
}

export function decideReviewItem(
  id: number,
  ownerId: string,
  nextState: ReviewItemState,
  note: string | null,
  decidedBy: string | null = ownerId,
): ReviewItem {
  const item = readReviewItem(id, ownerId);
  if (!item) throw new Error("Review item not found.");
  if (item.state === nextState) return item;
  if (!transitions[item.state].includes(nextState)) {
    throw new Error(`Cannot move a review item from ${item.state} to ${nextState}.`);
  }
  const normalizedNote = note?.trim() || null;
  const now = new Date().toISOString();
  archiveDb.exec("BEGIN IMMEDIATE");
  try {
    archiveDb.prepare(`
      UPDATE review_item
      SET state = ?, note = ?, decision_at = ?, decided_by = ?, updated_at = ?
      WHERE id = ? AND owner_id = ?
    `).run(nextState, normalizedNote, now, decidedBy, now, id, ownerId);
    archiveDb.prepare(`
      INSERT INTO review_item_decision
        (review_item_id, owner_id, from_state, to_state, note, decided_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, ownerId, item.state, nextState, normalizedNote, decidedBy, now);
    archiveDb.exec("COMMIT");
  } catch (error) {
    archiveDb.exec("ROLLBACK");
    throw error;
  }
  addEvent(
    nextState === "approved" ? "success" : nextState === "rejected" ? "warning" : "info",
    `Review item ${id} moved from ${item.state} to ${nextState}.`,
    "review-queue",
    ownerId,
    decidedBy,
  );
  const updated = readReviewItem(id, ownerId);
  if (!updated) throw new Error("Review item could not be read after decision.");
  return updated;
}

export function approveReviewItem(id: number, ownerId: string, note?: string | null) {
  return decideReviewItem(id, ownerId, "approved", note ?? null);
}

export function rejectReviewItem(id: number, ownerId: string, note?: string | null) {
  return decideReviewItem(id, ownerId, "rejected", note ?? null);
}

export function deferReviewItem(id: number, ownerId: string, note?: string | null) {
  return decideReviewItem(id, ownerId, "deferred", note ?? null);
}

export function reopenReviewItem(id: number, ownerId: string, note?: string | null) {
  return decideReviewItem(id, ownerId, "reopened", note ?? null);
}
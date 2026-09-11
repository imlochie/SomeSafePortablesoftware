/**
 * Archive quality findings.
 *
 * Turns the normalized technical quality model into a list of reviewable
 * findings about duplicates and encode relationships. This layer is read-only
 * by construction: it reads `file_record`, the cached Plex media/part rows, and
 * `archive_review`, and it never deletes, replaces, moves, or rewrites media.
 * Every finding carries `action: "review_only"` so the contract stays explicit.
 *
 * Review state reuses the existing `archive_review` semantics: a finding is
 * identified by owner + file record + finding kind + a deterministic evidence
 * key derived from the metadata that produced it. Unchanged evidence keeps a
 * finding reviewed; a meaningful change (new checksum, changed resolution, a
 * different counterpart, a shifted comparison) produces a new evidence key and
 * therefore reopens it, while the previous audit row is preserved.
 */

import { createHash } from "node:crypto";
import { archiveDb } from "../lib/archive-db";
import {
  invalidateArchiveInventoryCache,
  readArchiveInventory,
  type ArchiveInventoryRecord,
} from "./archive";
import {
  compareEncodes,
  qualitySnapshot,
  qualitySummaryLine,
  technicalQualityFromPlexMedia,
  technicalQualityFromRecord,
  type EncodeRelationship,
  type QualityAxisComparison,
  type QualityConfidence,
  type QualitySnapshot,
  type TechnicalQuality,
} from "./media-quality";

export type QualityFindingKind =
  | "exact_duplicate"
  | "probable_duplicate"
  | "lower_quality_duplicate"
  | "superior_encode"
  | "materially_different_encode"
  | "duration_mismatch"
  | "conflicting_quality_metadata"
  | "missing_technical_metadata";

export type FindingSeverity = "high" | "medium" | "low" | "info";
export type FindingReviewStatus = "unreviewed" | "reviewed" | "deferred" | "unresolved";
export type SavedFindingReviewStatus = Exclude<FindingReviewStatus, "unreviewed">;

export const qualityFindingKinds: QualityFindingKind[] = [
  "exact_duplicate",
  "probable_duplicate",
  "lower_quality_duplicate",
  "superior_encode",
  "materially_different_encode",
  "duration_mismatch",
  "conflicting_quality_metadata",
  "missing_technical_metadata",
];

const severityRank: Record<FindingSeverity, number> = { high: 3, medium: 2, low: 1, info: 0 };

/** Bitrate/size/duration consistency is only judged on substantial files. */
const BITRATE_CONSISTENCY_MIN_BYTES = 10 * 1024 * 1024;
const BITRATE_CONSISTENCY_TOLERANCE = 0.5;

const CONTAINER_BY_EXTENSION: Record<string, string[]> = {
  mkv: ["matroska", "webm"],
  mka: ["matroska", "webm"],
  webm: ["webm", "matroska"],
  mp4: ["mp4", "mov"],
  m4v: ["mp4", "mov", "m4v"],
  m4a: ["mp4", "mov", "m4a"],
  mov: ["mov", "mp4"],
  avi: ["avi"],
  wmv: ["asf", "wmv"],
  ts: ["mpegts", "ts"],
  m2ts: ["mpegts"],
  mpg: ["mpeg", "mpg"],
  mpeg: ["mpeg", "mpg"],
  flac: ["flac"],
  mp3: ["mp3"],
  wav: ["wav"],
  ogg: ["ogg", "ogm"],
  ogv: ["ogg", "ogm"],
};

export type QualityFindingRecord = {
  key: string;
  evidenceKey: string;
  fileRecordId: number;
  filename: string;
  relativePath: string | null;
  volumeId: string | null;
  kind: QualityFindingKind;
  relationship: EncodeRelationship;
  severity: FindingSeverity;
  confidence: QualityConfidence | null;
  headline: string;
  reason: string;
  reasons: string[];
  uncertainty: string[];
  currentQuality: QualitySnapshot;
  currentQualityLine: string;
  counterpart: QualitySnapshot | null;
  counterpartFileRecordId: number | null;
  counterpartRatingKey: string | null;
  counterpartLine: string | null;
  winner: "left" | "right" | null;
  preferredFilename: string | null;
  axes: QualityAxisComparison[];
  reviewStatus: FindingReviewStatus;
  reviewNote: string | null;
  reviewUpdatedAt: string | null;
  action: "review_only";
};

type ReviewRow = {
  status: SavedFindingReviewStatus;
  note: string | null;
  updated_at: string;
};

function hash(parts: unknown) {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

/**
 * Canonical digest of the measured evidence behind a finding. Location and
 * volume are deliberately excluded: renaming or moving a file does not change
 * whether two records are duplicates, so it must not reopen an answered
 * finding.
 */
function qualityEvidenceDigest(quality: TechnicalQuality) {
  return {
    checksum: quality.checksum,
    sizeBytes: quality.sizeBytes,
    width: quality.width,
    height: quality.height,
    pixels: quality.pixels,
    durationSeconds: quality.durationSeconds === null ? null : Math.round(quality.durationSeconds * 100) / 100,
    container: quality.container,
    videoCodec: quality.videoCodec,
    videoProfile: quality.videoProfile,
    pixelFormat: quality.pixelFormat,
    framerate: quality.framerate,
    containerBitrate: quality.containerBitrate,
    videoBitrate: quality.videoBitrate,
    audioBitrate: quality.audioBitrate,
    dynamicRange: quality.dynamicRange,
    audioCodec: quality.audioCodec,
    audioChannels: quality.audioChannels,
    audioChannelLayout: quality.audioChannelLayout,
    audioLanguages: [...quality.audioLanguages].sort(),
    subtitleLanguages: [...quality.subtitleLanguages].sort(),
    checksumStatus: quality.checksumStatus,
    fingerprint: quality.fingerprint,
    identityKey: quality.identityKey,
    provenance: quality.provenance,
    storageScope: quality.storageScope,
  };
}

function axisSignature(axes: QualityAxisComparison[]) {
  return axes
    .filter((axis) => axis.status !== "equal")
    .map((axis) => `${axis.axis}:${axis.status}`)
    .sort();
}

function readReviewRows(ownerId: string) {
  const rows = archiveDb.prepare(
    `SELECT file_record_id, finding_type, evidence_key, status, note, updated_at
     FROM archive_review
     WHERE owner_id = ?`,
  ).all(ownerId) as Array<ReviewRow & {
    file_record_id: number;
    finding_type: string;
    evidence_key: string;
  }>;
  const reviews = new Map<string, ReviewRow>();
  for (const row of rows) {
    reviews.set(`${row.file_record_id}:${row.finding_type}:${row.evidence_key}`, {
      status: row.status,
      note: row.note,
      updated_at: row.updated_at,
    });
  }
  return reviews;
}

function readPlexMediaRows(ownerId: string) {
  return archiveDb.prepare(`
    SELECT pm.id, pm.item_id, pi.rating_key, pi.title,
           pm.video_resolution, pm.video_codec, pm.audio_codec, pm.bitrate, pm.duration_ms,
           pp.file_path, pp.size_bytes, pp.checksum
    FROM plex_media pm
    JOIN plex_item pi ON pi.id = pm.item_id AND pi.owner_id = ?
    LEFT JOIN plex_part pp ON pp.id = (
      SELECT MIN(pp2.id) FROM plex_part pp2 WHERE pp2.media_id = pm.id
    )
    ORDER BY pm.id
  `).all(ownerId) as Array<{
    id: number;
    item_id: number;
    rating_key: string;
    title: string;
    video_resolution: string | null;
    video_codec: string | null;
    audio_codec: string | null;
    bitrate: number | null;
    duration_ms: number | null;
    file_path: string | null;
    size_bytes: number | null;
    checksum: string | null;
  }>;
}

type QualityFindingContext = {
  records: ArchiveInventoryRecord[];
  recordById: Map<number, ArchiveInventoryRecord>;
  qualityFor: (fileRecordId: number) => TechnicalQuality | null;
  volumeFor: (fileRecordId: number) => string | null;
  /**
   * The matched Plex item as the quality model sees it. Built once from the
   * stored media/part rows so the findings scan and the record report can
   * never describe the same counterpart with two different shapes.
   */
  plexQualityFor: (itemId: number) => TechnicalQuality | null;
};

function inventoryContext(ownerId: string) {
  const inventory = readArchiveInventory(ownerId);
  let plexQuality: Map<number, TechnicalQuality> | null = null;
  const loadPlexQuality = () => {
    if (plexQuality) return plexQuality;
    plexQuality = new Map();
    for (const mediaRow of readPlexMediaRows(ownerId)) {
      if (plexQuality.has(mediaRow.item_id)) continue;
      plexQuality.set(mediaRow.item_id, technicalQualityFromPlexMedia({
        id: mediaRow.id,
        ratingKey: mediaRow.rating_key,
        label: mediaRow.title,
        videoResolution: mediaRow.video_resolution,
        videoCodec: mediaRow.video_codec,
        audioCodec: mediaRow.audio_codec,
        // Plex reports media bitrate in kbps; the model normalizes to bps.
        bitrateKbps: mediaRow.bitrate,
        durationMs: mediaRow.duration_ms,
        part: mediaRow.file_path
          ? { filePath: mediaRow.file_path, sizeBytes: mediaRow.size_bytes, hash: mediaRow.checksum }
          : null,
      }));
    }
    return plexQuality;
  };
  const context: QualityFindingContext = {
    records: inventory.records,
    recordById: new Map(inventory.records.map((record) => [record.id, record])),
    qualityFor: (fileRecordId: number) => {
      const cached = inventory.context.indexes.quality.get(fileRecordId);
      if (cached) return cached;
      const row = inventory.context.indexes.rowsById.get(fileRecordId);
      return row ? technicalQualityFromRecord(row) : null;
    },
    volumeFor: (fileRecordId: number) =>
      inventory.context.indexes.rowsById.get(fileRecordId)?.volume_id ?? null,
    plexQualityFor: (itemId: number) => loadPlexQuality().get(itemId) ?? null,
  };
  return { inventory, context };
}

/** Relationships that say something reviewable about this record versus that peer. */
function rankComparable(relationship: EncodeRelationship) {
  return (
    relationship === "superior_encode"
    || relationship === "inferior_encode"
    || relationship === "materially_different_encode"
    || relationship === "probable_duplicate"
    || relationship === "different_media"
  );
}

/** Duplicate and quality findings for one owner, from metadata already stored. */
function buildFindings(ownerId: string): QualityFindingRecord[] {
  const { inventory, context } = inventoryContext(ownerId);
  const findings: QualityFindingRecord[] = [];
  const seen = new Set<string>();
  const active = context.records.filter((record) => record.scanStatus === "active");
  const { qualityFor, volumeFor, recordById, plexQualityFor } = context;

  const makeFinding = (input: {
    record: ArchiveInventoryRecord;
    kind: QualityFindingKind;
    relationship: EncodeRelationship;
    severity: FindingSeverity;
    confidence: QualityConfidence | null;
    headline: string;
    reasons: string[];
    uncertainty: string[];
    axes: QualityAxisComparison[];
    ownQuality: TechnicalQuality;
    counterpartQuality: TechnicalQuality | null;
    counterpartFileRecordId: number | null;
    counterpartRatingKey: string | null;
    winner: "left" | "right" | null;
  }): QualityFindingRecord => {
    const counterpartDigest = input.counterpartQuality
      ? qualityEvidenceDigest(input.counterpartQuality)
      : null;
    const evidenceKey = hash({
      kind: input.kind,
      fileRecordId: input.record.id,
      relationship: input.relationship,
      winner: input.winner,
      confidence: input.confidence,
      axes: axisSignature(input.axes),
      own: qualityEvidenceDigest(input.ownQuality),
      counterpart: {
        fileRecordId: input.counterpartFileRecordId,
        ratingKey: input.counterpartRatingKey,
        digest: counterpartDigest,
      },
    });
    const dedupe = (values: string[]) =>
      values.filter((value, index) => value && values.indexOf(value) === index);
    const reasons = dedupe(input.reasons);
    return {
      key: evidenceKey.slice(0, 16),
      evidenceKey,
      fileRecordId: input.record.id,
      filename: input.record.filename,
      relativePath: input.record.relativePath,
      volumeId: volumeFor(input.record.id),
      kind: input.kind,
      relationship: input.relationship,
      severity: input.severity,
      confidence: input.confidence,
      headline: input.headline,
      reason: reasons[0] ?? input.headline,
      reasons,
      uncertainty: dedupe(input.uncertainty),
      currentQuality: qualitySnapshot(input.ownQuality),
      currentQualityLine: qualitySummaryLine(input.ownQuality),
      counterpart: input.counterpartQuality ? qualitySnapshot(input.counterpartQuality) : null,
      counterpartFileRecordId: input.counterpartFileRecordId,
      counterpartRatingKey: input.counterpartRatingKey,
      counterpartLine: input.counterpartQuality
        ? `${input.counterpartQuality.label} - ${qualitySummaryLine(input.counterpartQuality)}`
        : null,
      winner: input.winner,
      preferredFilename: input.winner
        ? input.winner === "left"
          ? input.record.filename
          : input.counterpartQuality?.label ?? null
        : null,
      axes: input.axes,
      // Review state is layered on after findings are built.
      reviewStatus: "unreviewed",
      reviewNote: null,
      reviewUpdatedAt: null,
      action: "review_only",
    };
  };

  const push = (finding: QualityFindingRecord) => {
    const pair = `${finding.fileRecordId}:${finding.kind}:${finding.counterpartFileRecordId ?? finding.counterpartRatingKey ?? "none"}`;
    if (seen.has(pair)) return;
    seen.add(pair);
    findings.push(finding);
  };

  // --- 1. Byte-level duplicates: the only deterministic duplicate evidence. ---
  // The checksum index is built from `file_record.checksum`, which the scanner
  // now actually populates; a bucket with members is therefore proof, not a
  // heuristic. The lowest record id anchors the set so every run picks the same
  // representative.
  const duplicateCounterparts = new Map<number, number>();
  for (const [checksum, members] of inventory.context.indexes.checksum) {
    const membersById = members
      .map((member) => recordById.get(member.id))
      .filter((record): record is ArchiveInventoryRecord => record !== undefined && record.scanStatus === "active");
    if (membersById.length < 2) continue;
    const canonicalId = Math.min(...membersById.map((member) => member.id));
    const canonical = recordById.get(canonicalId);
    const canonicalQuality = canonical ? qualityFor(canonical.id) : null;
    if (!canonical || !canonicalQuality) continue;
    for (const record of membersById) {
      const quality = qualityFor(record.id);
      if (!quality) continue;
      const comparison = record.id === canonicalId ? null : compareEncodes(quality, canonicalQuality);
      // The anchor still needs a concrete counterpart to review against, so it
      // points at the next member of the set instead of at itself.
      const counterpartId = record.id === canonicalId
        ? (membersById.find((member) => member.id !== canonicalId)?.id ?? canonicalId)
        : canonicalId;
      const twinQuality = record.id === canonicalId ? qualityFor(counterpartId) ?? canonicalQuality : canonicalQuality;
      const counterpartRecord = recordById.get(counterpartId);
      const identitiesDisagree = Boolean(
        record.identityKey
        && counterpartRecord?.identityKey
        && record.identityKey !== counterpartRecord.identityKey,
      );
      duplicateCounterparts.set(record.id, canonicalId);
      push(makeFinding({
        record,
        kind: "exact_duplicate",
        relationship: "exact_duplicate",
        severity: "high",
        confidence: "high",
        headline: record.id === canonicalId
          ? "Anchor of a byte-identical set: this record holds the lowest archive id for this checksum."
          : "Byte-identical copy of another local file.",
        reasons: [
          record.id === canonicalId
            ? `SHA-256 ${checksum.slice(0, 12)}… is shared with ${membersById.length - 1} other active record(s); ${membersById.length} copies exist.`
            : `SHA-256 ${checksum.slice(0, 12)}… matches ${canonical.filename} (record #${canonicalId}).`,
          "Byte-identical files cannot differ in quality; what differs is how many copies you store.",
        ],
        uncertainty: identitiesDisagree
          ? ["These byte-identical records carry different media identities, so at least one filename needs an identity review (see naming proposals)."]
          : [],
        axes: comparison?.axes ?? [],
        ownQuality: quality,
        counterpartQuality: twinQuality,
        counterpartFileRecordId: counterpartId,
        counterpartRatingKey: null,
        winner: null,
      }));
    }
  }

  // --- 2. Probable duplicates: shared scanner fingerprint without byte proof. ---
  for (const [fingerprint, members] of inventory.context.indexes.fingerprint) {
    const membersById = members
      .map((member) => recordById.get(member.id))
      .filter((record): record is ArchiveInventoryRecord => record !== undefined && record.scanStatus === "active");
    if (membersById.length < 2) continue;
    const canonicalId = Math.min(...membersById.map((member) => member.id));
    const canonical = recordById.get(canonicalId);
    const canonicalQuality = canonical ? qualityFor(canonical.id) : null;
    if (!canonical || !canonicalQuality) continue;
    for (const record of membersById) {
      if (record.id === canonicalId) continue;
      if (duplicateCounterparts.get(record.id) === canonicalId) continue;
      const quality = qualityFor(record.id);
      if (!quality) continue;
      const comparison = compareEncodes(quality, canonicalQuality);
      if (comparison.relationship === "superior_encode" || comparison.relationship === "inferior_encode") {
        push(makeFinding({
          record,
          kind: comparison.winner === "left" ? "superior_encode" : "lower_quality_duplicate",
          relationship: comparison.relationship,
          severity: "medium",
          confidence: comparison.confidence,
          headline: comparison.winner === "left"
            ? "Dominates a fingerprint-identical local copy on every comparable measured axis."
            : "Fingerprint duplicate dominated by a better local copy.",
          reasons: comparison.reasons,
          uncertainty: comparison.uncertainty,
          axes: comparison.axes,
          ownQuality: quality,
          counterpartQuality: canonicalQuality,
          counterpartFileRecordId: canonical.id,
          counterpartRatingKey: null,
          winner: comparison.winner,
        }));
        continue;
      }
      push(makeFinding({
        record,
        kind: "probable_duplicate",
        relationship: "probable_duplicate",
        severity: "medium",
        confidence: quality.checksum && canonicalQuality.checksum ? "medium" : "low",
        headline: "Same scanner fingerprint as another local file, without byte-level proof.",
        reasons: [
          `Normalized title, rounded duration, dimensions, and codecs match ${canonical.filename} (record #${canonicalId})${fingerprint.length > 40 ? " (shared media fingerprint)" : ""}.`,
          quality.checksum && canonicalQuality.checksum && quality.checksum !== canonicalQuality.checksum
            ? "Both checksums exist and differ, so the files are similar but not identical."
            : "At least one checksum is unavailable, so byte-identity is unresolved.",
        ],
        uncertainty: [
          "A scanner fingerprint is coarse by design (title, rounded duration, dimensions, codec names); it can match across genuinely different encodes.",
          ...comparison.uncertainty,
        ],
        axes: comparison.axes,
        ownQuality: quality,
        counterpartQuality: canonicalQuality,
        counterpartFileRecordId: canonical.id,
        counterpartRatingKey: null,
        winner: null,
      }));
    }
  }

  // --- 3. Encode relationships inside one semantic identity. ---
  for (const [identityKey, group] of inventory.context.indexes.groups) {
    const members = group.memberIds
      .map((id) => recordById.get(id))
      .filter((record): record is ArchiveInventoryRecord => record !== undefined && record.scanStatus === "active");
    if (members.length < 2) continue;
    const champion = recordById.get(group.championId);
    for (const record of members) {
      const quality = qualityFor(record.id);
      if (!quality) continue;
      const peers = members.filter((member) => member.id !== record.id);
      if (group.ambiguous) {
        // Peer choice must not depend on row order. Rank the peers by how much
        // the stored metadata actually says about this record and pick the most
        // informative comparison: a measured dominance outranks a tradeoff,
        // a tradeoff outranks an unrelated runtime, and a peer that cannot be
        // compared at all produces no finding.
        const ranked = peers
          .map((peer) => {
            const peerQuality = qualityFor(peer.id);
            return peerQuality ? { peer, peerQuality, comparison: compareEncodes(quality, peerQuality) } : null;
          })
          .filter((candidate): candidate is {
            peer: ArchiveInventoryRecord;
            peerQuality: TechnicalQuality;
            comparison: ReturnType<typeof compareEncodes>;
          } => candidate !== null)
          .sort((left, right) => {
            const rank = (relationship: EncodeRelationship) =>
              relationship === "superior_encode" || relationship === "inferior_encode" ? 0
                : relationship === "materially_different_encode" || relationship === "probable_duplicate" ? 1
                  : relationship === "different_media" ? 2
                    : 3;
            return rank(left.comparison.relationship) - rank(right.comparison.relationship)
              || left.peer.id - right.peer.id;
          });
        const best = ranked.find((candidate) => rankComparable(candidate.comparison.relationship));
        if (!best) continue;
        const { peer: counterpart, peerQuality: counterpartQuality, comparison } = best;
        // An ambiguous group has no champion overall, which is not the same
        // statement as "this pair cannot be ranked": the relationship measured
        // against this specific counterpart decides the kind, so a dominance
        // result is reported as dominance instead of being flattened into a
        // stalemate that its own reasons contradict.
        if (comparison.relationship === "exact_duplicate") continue;
        const differentCut = comparison.relationship === "different_media";
        const decided = comparison.relationship === "superior_encode" || comparison.relationship === "inferior_encode";
        const kind: QualityFindingKind = differentCut
          ? "duration_mismatch"
          : comparison.relationship === "superior_encode"
            ? "superior_encode"
            : comparison.relationship === "inferior_encode"
              ? "lower_quality_duplicate"
              : "materially_different_encode";
        push(makeFinding({
          record,
          kind,
          relationship: comparison.relationship,
          severity: kind === "superior_encode" ? "low" : "medium",
          confidence: comparison.confidence ?? "low",
          headline: differentCut
            ? "Stored under one identity, but the runtimes differ by more than a re-encode explains: these are different cuts, not competing versions."
            : comparison.relationship === "superior_encode"
              ? `Dominates ${counterpart.filename} on every comparable measured axis, although this identity group has no single best version overall.`
              : comparison.relationship === "inferior_encode"
                ? `Dominated by ${counterpart.filename}, which is at least as good everywhere measured and better somewhere.`
                : "Versions of the same title trade off against each other; no encode is defensibly better.",
          reasons: [
            differentCut
              ? `${identityKey} groups ${members.length} active local versions whose durations disagree beyond the re-encode tolerance.`
              : `${identityKey} has ${members.length} active local versions and no single version dominates the others.`,
            ...comparison.reasons,
          ],
          uncertainty: differentCut
            ? [
              "Nothing is said about which encode is better: first confirm whether these files are meant to be the same item at all, since runtime gaps usually mean separate cuts, editions, or a truncated file.",
              ...comparison.uncertainty,
            ]
            : decided
              ? [
                "This pair has a measured winner; the group as a whole does not, because another member is not comparable to it.",
                ...comparison.uncertainty,
              ]
              : [
                "This is a preference decision: each candidate leads somewhere in the stored metadata, so a 'best copy' label would be invented rather than measured.",
                ...comparison.uncertainty,
              ],
          axes: comparison.axes,
          ownQuality: quality,
          counterpartQuality,
          counterpartFileRecordId: counterpart.id,
          counterpartRatingKey: null,
          winner: decided ? comparison.winner : null,
        }));
        continue;
      }
      if (!champion) continue;
      const championQuality = qualityFor(champion.id);
      if (!championQuality) continue;
      const isChampion = record.id === champion.id;
      const counterpart = isChampion ? peers[0] : champion;
      const counterpartQuality = counterpart ? qualityFor(counterpart.id) : null;
      if (!counterpart || !counterpartQuality) continue;
      const comparison = compareEncodes(quality, counterpartQuality);
      // Dominance inside the group never licenses a claim about a pair the
      // engine refused to rank, so the measured relationship is carried
      // through and anything that is not a clear win in one direction is
      // reported as a duration mismatch instead of a quality verdict.
      if (comparison.relationship === "different_media") {
        push(makeFinding({
          record,
          kind: "duration_mismatch",
          relationship: comparison.relationship,
          severity: "medium",
          confidence: comparison.confidence ?? "low",
          headline: "The other local version of this identity runs for a different length, so the two are not the same item.",
          reasons: comparison.reasons,
          uncertainty: comparison.uncertainty,
          axes: comparison.axes,
          ownQuality: quality,
          counterpartQuality,
          counterpartFileRecordId: counterpart.id,
          counterpartRatingKey: null,
          winner: null,
        }));
        continue;
      }
      if (isChampion && comparison.relationship !== "superior_encode") continue;
      if (!isChampion && comparison.relationship !== "inferior_encode") continue;
      push(makeFinding({
        record,
        kind: isChampion ? "superior_encode" : "lower_quality_duplicate",
        relationship: comparison.relationship,
        severity: isChampion ? "low" : "medium",
        confidence: comparison.confidence,
        headline: isChampion
          ? `Best local version of this identity; dominates ${peers.length} other version(s).`
          : "Lower-quality duplicate: another local version is at least as good everywhere measured and better somewhere.",
        reasons: [
          ...(isChampion
            ? [
              ...comparison.reasons,
              "Superior means dominance on measured axes only; it is not a recommendation to remove anything.",
            ]
            : comparison.reasons),
        ],
        uncertainty: comparison.uncertainty,
        axes: comparison.axes,
        ownQuality: quality,
        counterpartQuality,
        counterpartFileRecordId: counterpart.id,
        counterpartRatingKey: null,
        winner: isChampion ? "left" : "right",
      }));
    }
  }

  // --- 4. Local file versus the matched Plex media/part. ---
  for (const record of active) {
    if (!record.plexMatch) continue;
    const plexRow = inventory.context.plexRows.find((candidate) => candidate.rating_key === record.plexMatch?.ratingKey);
    const counterpartQuality = plexRow ? plexQualityFor(plexRow.id) : null;
    const quality = qualityFor(record.id);
    if (!quality || !counterpartQuality) continue;
    const comparison = compareEncodes(quality, counterpartQuality);
    if (
      comparison.relationship === "equivalent"
      || comparison.relationship === "insufficient_metadata"
    ) {
      continue;
    }
    // A runtime gap against the matched Plex item questions the identity match
    // itself, so it is reported instead of being treated as a non-comparison.
    if (comparison.relationship === "different_media") {
      push(makeFinding({
        record,
        kind: "duration_mismatch",
        relationship: comparison.relationship,
        severity: "low",
        confidence: "low",
        headline: "This file and the Plex item matched to it run for different lengths.",
        reasons: comparison.reasons,
        uncertainty: [
          "Plex matches are made on title and year, so a runtime gap usually means the library holds a different cut rather than a worse encode.",
          ...comparison.uncertainty,
        ],
        axes: comparison.axes,
        ownQuality: quality,
        counterpartQuality,
        counterpartFileRecordId: null,
        counterpartRatingKey: record.plexMatch.ratingKey,
        winner: null,
      }));
      continue;
    }
    const kind: QualityFindingKind = comparison.relationship === "superior_encode"
      ? "superior_encode"
      : comparison.relationship === "inferior_encode"
        ? "lower_quality_duplicate"
        : "materially_different_encode";
    push(makeFinding({
      record,
      kind,
      relationship: comparison.relationship,
      severity: kind === "lower_quality_duplicate" ? "medium" : "low",
      confidence: comparison.confidence,
      headline: kind === "superior_encode"
        ? "Local copy is measurably ahead of the matched Plex version."
        : kind === "lower_quality_duplicate"
          ? "The matched Plex version is measurably ahead of this local copy."
          : "Local and Plex versions differ in ways the stored metadata cannot rank.",
      reasons: comparison.reasons,
      uncertainty: comparison.uncertainty,
      axes: comparison.axes,
      ownQuality: quality,
      counterpartQuality,
      counterpartFileRecordId: null,
      counterpartRatingKey: record.plexMatch.ratingKey,
      winner: comparison.winner,
    }));
  }

  // --- 5. Conflicting and missing technical metadata. ---
  for (const record of context.records) {
    const quality = qualityFor(record.id);
    if (!quality) continue;
    if (record.scanStatus === "error" || quality.technicalMetadataMissing) {
      push(makeFinding({
        record,
        kind: "missing_technical_metadata",
        relationship: "insufficient_metadata",
        severity: "high",
        confidence: null,
        headline: "No usable technical metadata; quality cannot be compared for this record.",
        reasons: [
          record.errorMessage
            ? `FFprobe reported: ${record.errorMessage}`
            : "The record has a size but no probed stream information.",
        ],
        uncertainty: [
          "Duplicate and encode conclusions are withheld for this record instead of being guessed from the filename.",
        ],
        axes: [],
        ownQuality: quality,
        counterpartQuality: null,
        counterpartFileRecordId: null,
        counterpartRatingKey: null,
        winner: null,
      }));
      continue;
    }

    const issues: string[] = [];

    // Byte-identical records must agree on their technical metadata.
    for (const twin of (record.checksum ? inventory.context.indexes.checksum.get(record.checksum) ?? [] : [])) {
      if (twin.id === record.id) continue;
      const twinQuality = qualityFor(twin.id);
      const twinRecord = recordById.get(twin.id);
      if (!twinQuality || !twinRecord) continue;
      const conflicts: string[] = [];
      if (quality.height !== null && twinQuality.height !== null && quality.height !== twinQuality.height) {
        conflicts.push(`height ${quality.height} vs ${twinQuality.height}`);
      }
      if (quality.width !== null && twinQuality.width !== null && quality.width !== twinQuality.width) {
        conflicts.push(`width ${quality.width} vs ${twinQuality.width}`);
      }
      if (quality.videoCodec && twinQuality.videoCodec && quality.videoCodec !== twinQuality.videoCodec) {
        conflicts.push(`video codec ${quality.videoCodec} vs ${twinQuality.videoCodec}`);
      }
      if (quality.audioCodec && twinQuality.audioCodec && quality.audioCodec !== twinQuality.audioCodec) {
        conflicts.push(`audio codec ${quality.audioCodec} vs ${twinQuality.audioCodec}`);
      }
      if (conflicts.length) {
        push(makeFinding({
          record,
          kind: "conflicting_quality_metadata",
          relationship: "exact_duplicate",
          severity: "high",
          confidence: "high",
          headline: "Byte-identical files report different technical metadata.",
          reasons: [
            `SHA-256 matches ${twinRecord.filename} (record #${twin.id}), so the bytes are the same, but ${conflicts.join(", ")} disagree.`,
          ],
          uncertainty: [
            "Trust the checksum, not the metadata: one of these probe results is stale or wrong and needs re-inspection.",
          ],
          axes: [],
          ownQuality: quality,
          counterpartQuality: twinQuality,
          counterpartFileRecordId: twin.id,
          counterpartRatingKey: null,
          winner: null,
        }));
        break;
      }
    }

    if (
      quality.sizeBytes !== null
      && quality.sizeBytes >= BITRATE_CONSISTENCY_MIN_BYTES
      && quality.containerBitrate !== null
      && quality.durationSeconds !== null
      && quality.durationSeconds > 0
    ) {
      const expected = (quality.sizeBytes * 8) / quality.durationSeconds;
      const deviation = expected > 0 ? Math.abs(quality.containerBitrate - expected) / expected : 0;
      if (deviation > BITRATE_CONSISTENCY_TOLERANCE) {
        issues.push(
          `Reported container bitrate ${Math.round(quality.containerBitrate / 1000)} kbps disagrees with size/duration (${Math.round(expected / 1000)} kbps) by ${Math.round(deviation * 100)}%.`,
        );
      }
    }

    if (quality.checksumStatus === "failed") {
      issues.push("The checksum could not be computed, so byte-level duplicate status is unknown for this file.");
    }

    const extension = record.filename.match(/\.([A-Za-z0-9]+)$/)?.[1]?.toLowerCase() ?? "";
    const expectedContainers = CONTAINER_BY_EXTENSION[extension];
    if (extension && quality.container && expectedContainers
      && !expectedContainers.some((token) => quality.container?.includes(token))) {
      issues.push(
        `Extension .${extension} normally implies ${expectedContainers.join(" or ")}, but the probe reported container ${quality.container}.`,
      );
    }

    if (issues.length) {
      push(makeFinding({
        record,
        kind: "conflicting_quality_metadata",
        relationship: "insufficient_metadata",
        severity: "medium",
        confidence: "medium",
        headline: "Stored technical metadata disagrees with itself.",
        reasons: issues,
        uncertainty: [
          "Container bitrate is an average and can legitimately disagree with size/duration for variable-bitrate or partially written files; treat this as a prompt to re-inspect, not as proof of a bad encode.",
        ],
        axes: [],
        ownQuality: quality,
        counterpartQuality: null,
        counterpartFileRecordId: null,
        counterpartRatingKey: null,
        winner: null,
      }));
    }
  }

  findings.sort((left, right) => {
    const severity = severityRank[right.severity] - severityRank[left.severity];
    if (severity !== 0) return severity;
    if (left.fileRecordId !== right.fileRecordId) return left.fileRecordId - right.fileRecordId;
    if (left.kind !== right.kind) return left.kind.localeCompare(right.kind);
    return (left.counterpartFileRecordId ?? 0) - (right.counterpartFileRecordId ?? 0);
  });

  return findings;
}

// Findings are memoized against the inventory object they were derived from.
// Any scan or review write invalidates that cache, so the memo can never
// outlive the data it describes.
const findingsMemo = new WeakMap<object, QualityFindingRecord[]>();

function findingsFor(ownerId: string): QualityFindingRecord[] {
  const inventory = readArchiveInventory(ownerId) as unknown as object;
  const memo = findingsMemo.get(inventory);
  if (memo) return memo;
  const findings = buildFindings(ownerId);
  findingsMemo.set(inventory, findings);
  return findings;
}

function applyReviewState(ownerId: string, findings: QualityFindingRecord[]) {
  const reviews = readReviewRows(ownerId);
  for (const finding of findings) {
    const row = reviews.get(`${finding.fileRecordId}:${finding.kind}:${finding.evidenceKey}`);
    finding.reviewStatus = row?.status ?? "unreviewed";
    finding.reviewNote = row?.note ?? null;
    finding.reviewUpdatedAt = row?.updated_at ?? null;
  }
  return findings;
}

function pageNumber(value: number | undefined, fallback: number, max: number) {
  return Number.isInteger(value) ? Math.max(1, Math.min(max, value as number)) : fallback;
}

export type QualityFindingFilters = {
  page?: number;
  pageSize?: number;
  kind?: string;
  reviewStatus?: string;
  fileRecordId?: number;
  volume?: string;
  confidence?: string;
  includeReviewed?: boolean;
};

export function readQualityFindings(ownerId: string, filters: QualityFindingFilters = {}) {
  const all = applyReviewState(ownerId, findingsFor(ownerId));
  const results = all.filter((finding) => {
    if (filters.kind && finding.kind !== filters.kind) return false;
    if (filters.confidence && finding.confidence !== filters.confidence) return false;
    if (filters.fileRecordId !== undefined && finding.fileRecordId !== filters.fileRecordId) return false;
    if (filters.volume && finding.currentQuality.volumeId !== filters.volume) return false;
    if (filters.reviewStatus && finding.reviewStatus !== filters.reviewStatus) return false;
    if (filters.includeReviewed === false && finding.reviewStatus === "reviewed") return false;
    return true;
  });
  const pageSize = pageNumber(filters.pageSize, 50, 500);
  const page = pageNumber(filters.page, 1, 100_000);
  const offset = (page - 1) * pageSize;
  return {
    summary: {
      total: all.length,
      exactDuplicateCount: all.filter((finding) => finding.kind === "exact_duplicate").length,
      probableDuplicateCount: all.filter((finding) => finding.kind === "probable_duplicate").length,
      lowerQualityCount: all.filter((finding) => finding.kind === "lower_quality_duplicate").length,
      superiorCount: all.filter((finding) => finding.kind === "superior_encode").length,
      materialDifferenceCount: all.filter((finding) => finding.kind === "materially_different_encode").length,
      durationMismatchCount: all.filter((finding) => finding.kind === "duration_mismatch").length,
      conflictingMetadataCount: all.filter((finding) => finding.kind === "conflicting_quality_metadata").length,
      missingMetadataCount: all.filter((finding) => finding.kind === "missing_technical_metadata").length,
      unreviewedCount: all.filter((finding) => finding.reviewStatus === "unreviewed").length,
      reviewedCount: all.filter((finding) => finding.reviewStatus === "reviewed").length,
      affectedFiles: new Set(all.map((finding) => finding.fileRecordId)).size,
    },
    pagination: {
      page,
      pageSize,
      total: results.length,
      totalPages: Math.ceil(results.length / pageSize),
    },
    results: results.slice(offset, offset + pageSize),
  };
}

export type QualityComparisonView = {
  counterpart: QualitySnapshot;
  counterpartFileRecordId: number | null;
  counterpartRatingKey: string | null;
  relationship: EncodeRelationship;
  winner: "left" | "right" | null;
  confidence: QualityConfidence | null;
  reasons: string[];
  uncertainty: string[];
  axes: QualityAxisComparison[];
};

function compareWith(
  quality: TechnicalQuality,
  counterpartQuality: TechnicalQuality,
  counterpartFileRecordId: number | null,
  counterpartRatingKey: string | null,
): QualityComparisonView {
  const comparison = compareEncodes(quality, counterpartQuality);
  return {
    counterpart: qualitySnapshot(counterpartQuality),
    counterpartFileRecordId,
    counterpartRatingKey,
    relationship: comparison.relationship,
    winner: comparison.winner,
    confidence: comparison.confidence,
    reasons: comparison.reasons,
    uncertainty: comparison.uncertainty,
    axes: comparison.axes,
  };
}

/** Everything the quality layer knows about one archive record. */
export function readRecordQualityReport(ownerId: string, fileRecordId: number) {
  const { inventory, context } = inventoryContext(ownerId);
  const record = inventory.records.find((candidate) => candidate.id === fileRecordId);
  if (!record) return null;
  const quality = context.qualityFor(record.id);
  if (!quality) return null;
  const findings = applyReviewState(ownerId, findingsFor(ownerId)).filter(
    (finding) => finding.fileRecordId === fileRecordId,
  );
  const comparisons = (inventory.context.indexes.identity.get(record.identityKey) ?? [])
    .filter((candidate) => candidate.id !== record.id)
    .map((candidate) => {
      const counterpartQuality = context.qualityFor(candidate.id);
      const counterpartRecord = inventory.records.find((row) => row.id === candidate.id);
      if (!counterpartQuality || !counterpartRecord) return null;
      return compareWith(quality, counterpartQuality, counterpartRecord.id, null);
    })
    .filter((comparison): comparison is QualityComparisonView => comparison !== null);
  const plexRow = record.plexMatch
    ? inventory.context.plexRows.find((candidate) => candidate.rating_key === record.plexMatch?.ratingKey)
    : undefined;
  const plexCounterpart = plexRow ? context.plexQualityFor(plexRow.id) : null;
  if (plexCounterpart) {
    comparisons.push(compareWith(quality, plexCounterpart, null, record.plexMatch?.ratingKey ?? null));
  }
  return {
    fileRecordId: record.id,
    filename: record.filename,
    relativePath: record.relativePath,
    identityKey: record.identityKey,
    currentQuality: qualitySnapshot(quality),
    currentQualityLine: qualitySummaryLine(quality),
    comparisons,
    findings,
    action: "review_only" as const,
  };
}

/**
 * Saves a review decision for one finding. Only `archive_review` is written:
 * media files, file records, and Plex rows are untouched.
 */
export function saveQualityFindingReview(
  ownerId: string,
  input: {
    fileRecordId: number;
    kind: QualityFindingKind;
    evidenceKey: string;
    status: SavedFindingReviewStatus;
    note: string | null;
  },
) {
  const finding = applyReviewState(ownerId, findingsFor(ownerId)).find(
    (candidate) =>
      candidate.fileRecordId === input.fileRecordId
      && candidate.kind === input.kind
      && candidate.evidenceKey === input.evidenceKey,
  );
  if (!finding) return null;
  archiveDb.prepare(
    `INSERT INTO archive_review
      (owner_id, file_record_id, finding_type, evidence_key, status, note, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(owner_id, file_record_id, finding_type, evidence_key) DO UPDATE SET
       status = excluded.status, note = excluded.note, updated_at = CURRENT_TIMESTAMP`,
  ).run(ownerId, finding.fileRecordId, finding.kind, finding.evidenceKey, input.status, input.note);
  const saved = archiveDb.prepare(
    `SELECT status, finding_type, note, updated_at
     FROM archive_review
     WHERE owner_id = ? AND file_record_id = ? AND finding_type = ? AND evidence_key = ?`,
  ).get(ownerId, finding.fileRecordId, finding.kind, finding.evidenceKey) as {
    status: SavedFindingReviewStatus;
    finding_type: string;
    note: string | null;
    updated_at: string;
  };
  invalidateArchiveInventoryCache(ownerId);
  return {
    status: saved.status,
    findingType: saved.finding_type,
    note: saved.note,
    reviewedAt: saved.updated_at,
    updatedAt: saved.updated_at,
  };
}

import { readArchiveInventory } from "./archive";
import { readNamingProposals } from "./naming-intelligence";

export type ArchiveHealthCategory = "integrity" | "naming" | "metadata" | "duplicate" | "stale";
export type ArchiveHealthState = "needs_you" | "interesting" | "waiting" | "uncertain" | "blocked" | "resolved";
export type ArchiveHealthFinding = {
  id: string;
  category: ArchiveHealthCategory;
  severity: "info" | "warning" | "critical";
  title: string;
  summary: string;
  state: ArchiveHealthState;
  confidence: number | null;
  whyItMatters: string;
  known: string[];
  unknowns: string[];
  recommendedAction: "review" | "repair" | "investigate" | "wait" | "none";
  source: string;
  sourceId: string;
};

export async function readArchiveHealth(ownerId: string) {
  const inventory = readArchiveInventory(ownerId);
  const findings: ArchiveHealthFinding[] = [];
  for (const record of inventory.records) {
    if (record.integrityClassification === "corrupt_or_malformed_container" || record.scanStatus === "error") {
      findings.push({ id: `integrity:${record.id}`, category: "integrity", severity: record.integrityClassification === "corrupt_or_malformed_container" ? "critical" : "warning", title: "A file needs an integrity check", summary: record.errorMessage ?? record.integritySummary ?? "The file could not be inspected reliably.", state: "needs_you", confidence: record.integrityClassification === "corrupt_or_malformed_container" ? 0.8 : null, whyItMatters: "This file may not be safe to use until its condition is understood.", known: [record.filename, record.scanStatus], unknowns: record.errorMessage ? [] : ["The reason inspection failed"], recommendedAction: "review", source: "archive_record", sourceId: String(record.id) });
    }
    if (record.qualityStatus === "duplicate") findings.push({ id: `duplicate:${record.id}`, category: "duplicate", severity: "warning", title: "A duplicate file was found", summary: record.qualitySummary, state: "needs_you", confidence: record.checksum && record.duplicateOfId ? 1 : 0.6, whyItMatters: "Keeping identical copies may use archive space without adding another version.", known: [record.filename, ...(record.qualityDifferences ?? [])], unknowns: record.duplicateOfId ? [] : ["Which copy should be kept"], recommendedAction: "review", source: "archive_record", sourceId: String(record.id) });
    if (!record.audioLanguages?.length && !record.subtitleLanguages?.length) findings.push({ id: `metadata:${record.id}`, category: "metadata", severity: "info", title: "Metadata is incomplete", summary: `${record.filename} has no detected audio or subtitle language metadata.`, state: "uncertain", confidence: null, whyItMatters: "Incomplete metadata can make searching and playback decisions harder.", known: [record.filename], unknowns: ["Whether the media actually contains language tracks"], recommendedAction: "investigate", source: "archive_record", sourceId: String(record.id) });
  }
  const naming = await readNamingProposals(ownerId, { operation: "rename", page: 1, pageSize: 100 });
  if (naming.pagination.total > 0) findings.push({ id: "naming:proposals", category: "naming", severity: "warning", title: "Files have naming suggestions", summary: `${naming.pagination.total} files have a deterministic naming proposal.`, state: "needs_you", confidence: null, whyItMatters: "Consistent names make the archive easier to browse and match.", known: [`${naming.pagination.total} naming proposals`], unknowns: [], recommendedAction: "review", source: "naming_proposals", sourceId: "rename" });
  const counts = { needsYou: findings.filter((finding) => finding.state === "needs_you").length, uncertain: findings.filter((finding) => finding.state === "uncertain").length, waiting: findings.filter((finding) => finding.state === "waiting").length, resolved: findings.filter((finding) => finding.state === "resolved").length };
  return { generatedAt: new Date().toISOString(), counts, findings };
}

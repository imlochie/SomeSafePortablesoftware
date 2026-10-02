import { readAssistantOverview } from "./assistant-overview";
import { readMediaExperience } from "./media-experience";

type ArenaConfig = { baseUrl: string; modelId: string; apiKey: string | null };
function redact(value: unknown): unknown {
  if (typeof value === "string") return value.replace(/(?:[A-Za-z]:\\|\\\\|\/)(?:[^\s/\\]+[\/\\])+[^\s/\\]+/g, "[local path redacted]");
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redact(item)]));
  return value;
}
function config(): ArenaConfig | null {
  const baseUrl = process.env.ARENA_CANONICAL_URL?.trim().replace(/\/$/, "");
  if (!baseUrl) return null;
  return { baseUrl, modelId: process.env.ARENA_CANONICAL_MODEL?.trim() || "offline-sage", apiKey: process.env.ARENA_CANONICAL_API_KEY?.trim() || null };
}
export function arenaCanonicalStatus() { const value = config(); return { configured: Boolean(value), endpoint: value ? "configured" : "not_configured", model: value?.modelId ?? null }; }
export function arenaToolManifest() {
  return {
    protocol: "archive-assistant-agent-v1",
    safety: { directMutation: false, approvalRequired: true, preflightRequired: true },
    tools: [
      { name: "archive.get_context", method: "GET", path: "/api/agent/context", readOnly: true },
      { name: "archive.create_insight_brief", method: "POST", path: "/api/agent/insights", readOnly: true },
      { name: "archive.create_research_brief", method: "POST", path: "/api/agent/research", readOnly: true },
      { name: "archive.inspect_download_source", method: "POST", path: "/api/agent/downloads/inspect", readOnly: true },
      { name: "archive.queue_approved_download", method: "POST", path: "/api/agent/downloads/queue", readOnly: false, requiresApproval: true },
      { name: "archive.list_monitors", method: "GET", path: "/api/agent/monitoring/sources", readOnly: true },
    ],
  };
}
export async function askArenaCanonical(ownerId: string, question: string) {
  const settings = config(); if (!settings) throw new Error("Arena Canonical is not configured. Set ARENA_CANONICAL_URL on the local API.");
  const overview = await readAssistantOverview(ownerId); const media = readMediaExperience(ownerId);
  const evidence = {
    contract: "archive-assistant-agent-v1", ownerScoped: true,
    safety: { approvalRequired: true, preflightRequired: true, directMutation: false },
    archive: { summary: overview.summary, activeWork: overview.activeWork, attention: overview.attention.slice(0, 30), groups: overview.groups.slice(0, 50), uncertain: overview.uncertain.slice(0, 30) },
    personal: { sourceStatus: media.sourceStatus, summary: media.summary, currentViewingMomentum: media.currentViewingMomentum, personalizedBriefing: overview.personalizedBriefing.slice(0, 30) },
  };
  const safeEvidence = redact(evidence);
  const response = await fetch(`${settings.baseUrl}/api/chat`, { method: "POST", headers: { "content-type": "application/json", ...(settings.apiKey ? { authorization: `Bearer ${settings.apiKey}` } : {}) }, body: JSON.stringify({ modelId: settings.modelId, messages: [{ role: "system", content: "You are the Archive Assistant reasoning layer. Use only the supplied archive evidence. Cite evidence IDs, separate facts from uncertainty, personalize recommendations, and never claim to have executed a change. Any mutation must remain an approval-gated plan." }, { role: "user", content: `${question}\n\nArchive evidence:\n${JSON.stringify(safeEvidence)}` }], localOnly: !settings.apiKey }) , signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`Arena Canonical returned HTTP ${response.status}.`);
  const payload = await response.json() as Record<string, unknown>;
  return { answer: typeof payload.text === "string" ? payload.text : typeof payload.answer === "string" ? payload.answer : JSON.stringify(payload), modelId: settings.modelId, evidenceSnapshot: safeEvidence };
}

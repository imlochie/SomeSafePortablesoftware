import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { SettingsRecord } from "../lib/archive-db";
import { readMediaExperience } from "./media-experience";
import { readAssistantOverview } from "./assistant-overview";

type MonitorKind = "rss" | "atom" | "json" | "html";
export type SourceMonitor = {
  id: string;
  ownerId: string;
  name: string;
  url: string;
  kind: MonitorKind;
  enabled: boolean;
  intervalMinutes: number;
  targets: Array<{ title: string; mediaType?: "movie" | "series" | "episode"; season?: number }>;
  discovery: boolean;
  lastCheckedAt: string | null;
  lastSuccessfulCheckAt: string | null;
  lastFingerprint: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
};
export type MonitorNotification = {
  id: string;
  monitorId: string;
  ownerId: string;
  title: string;
  matchedTarget: string;
  url: string | null;
  evidence: string[];
  firstSeenAt: string;
  read: boolean;
};
type Store = { monitors: SourceMonitor[]; notifications: MonitorNotification[] };

function storePath(settings: SettingsRecord) { return join(settings.dataDirectory, "source-monitoring.json"); }
async function readStore(settings: SettingsRecord): Promise<Store> {
  try { return JSON.parse(await fs.readFile(storePath(settings), "utf8")) as Store; }
  catch { return { monitors: [], notifications: [] }; }
}
async function writeStore(settings: SettingsRecord, value: Store) {
  const path = storePath(settings); await fs.mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`; await fs.writeFile(temp, JSON.stringify(value, null, 2), "utf8"); await fs.rename(temp, path);
}
function text(value: unknown) { return typeof value === "string" ? value.trim() : ""; }
function normalize(value: string) { return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(); }
function boundedInterval(value: unknown) { const n = Number(value); return Number.isFinite(n) ? Math.max(5, Math.min(24 * 60, Math.floor(n))) : 60; }
function safeUrl(value: string) { const url = new URL(value); if (!["http:", "https:"].includes(url.protocol)) throw new Error("Only public HTTP(S) sources can be monitored."); return url.toString(); }
function strip(value: string) { return value.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(); }
function parseItems(body: string, kind: MonitorKind, baseUrl: string) {
  if (kind === "json") {
    const value = JSON.parse(body) as any; const rows = Array.isArray(value) ? value : (value.items ?? value.results ?? []);
    return Array.isArray(rows) ? rows.map((row) => ({ title: text(row.title ?? row.name), url: text(row.url ?? row.link) || null, evidence: ["public JSON source"] })).filter((x) => x.title) : [];
  }
  if (kind === "rss" || kind === "atom") {
    const entries: Array<{ title: string; url: string | null; evidence: string[] }> = [];
    for (const match of body.matchAll(/<(?:item|entry)\b[\s\S]*?<\/(?:item|entry)>/gi)) {
      const block = match[0]; const title = strip(block.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "");
      const href = block.match(/<link[^>]*(?:href=["']([^"']+)|>([^<]+))/i); let url = text(href?.[1] ?? href?.[2]) || null;
      try { if (url) url = new URL(url, baseUrl).toString(); } catch { url = null; }
      if (title) entries.push({ title, url, evidence: [`${kind} item`, "public source metadata"] });
    }
    return entries;
  }
  const entries: Array<{ title: string; url: string | null; evidence: string[] }> = [];
  // Many modern catalogues expose their listing content as ordinary server
  // rendered links rather than RSS. Keep this deliberately generic: extract
  // public link text and image alt text, but never execute page JavaScript or
  // follow download links.
  for (const match of body.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const attributes = match[1] ?? "";
    const block = match[2] ?? "";
    const href = attributes.match(/\bhref\s*=\s*["']([^"']+)["']/i)?.[1] ?? null;
    const imageAlt = block.match(/<img\b[^>]*\balt\s*=\s*["']([^"']+)["']/i)?.[1] ?? "";
    const title = strip(block).replace(/^(view|watch|download)\s+(details?|now)\s*$/i, "").trim() || strip(imageAlt);
    if (title.length < 2 || /^(home|menu|search|login|sign up|movies|series|anime|next|previous)$/i.test(title)) continue;
    let url = href;
    try { if (url) url = new URL(url, baseUrl).toString(); } catch { url = null; }
    entries.push({ title: title.slice(0, 500), url, evidence: ["public HTML link", "public page metadata"] });
  }
  if (entries.length) return entries;
  const page = strip(body); return page ? [{ title: page.slice(0, 500), url: baseUrl, evidence: ["public HTML page text"] }] : [];
}
function detectKind(contentType: string, url: string, requested?: MonitorKind): MonitorKind {
  if (requested) return requested;
  if (/json/i.test(contentType) || /\.json(?:$|\?)/i.test(url)) return "json";
  if (/rss|xml|atom/i.test(contentType) || /feed|rss|atom/i.test(url)) return /atom/i.test(contentType) ? "atom" : "rss";
  return "html";
}

export async function listSourceMonitors(ownerId: string, settings: SettingsRecord) { const s = await readStore(settings); return s.monitors.filter((m) => m.ownerId === ownerId); }
export async function listMonitorNotifications(ownerId: string, settings: SettingsRecord) { const s = await readStore(settings); return s.notifications.filter((n) => n.ownerId === ownerId).slice(-100).reverse(); }
export async function createSourceMonitor(ownerId: string, input: { name: string; url: string; kind?: MonitorKind; intervalMinutes?: number; targets?: SourceMonitor["targets"]; discovery?: boolean }, settings: SettingsRecord) {
  const now = new Date().toISOString(); const source: SourceMonitor = { id: randomUUID(), ownerId, name: text(input.name) || new URL(input.url).hostname, url: safeUrl(input.url), kind: input.kind ?? "html", enabled: true, intervalMinutes: boundedInterval(input.intervalMinutes), targets: (input.targets ?? []).filter((t) => text(t.title)).map((t) => ({ ...t, title: text(t.title) })), discovery: input.discovery === true, lastCheckedAt: null, lastSuccessfulCheckAt: null, lastFingerprint: null, lastError: null, createdAt: now, updatedAt: now };
  const store = await readStore(settings); store.monitors.push(source); await writeStore(settings, store); return source;
}
export async function checkSourceMonitor(ownerId: string, id: string, settings: SettingsRecord) {
  const store = await readStore(settings); const monitor = store.monitors.find((m) => m.ownerId === ownerId && m.id === id); if (!monitor) throw new Error("Source monitor not found.");
  const checked = new Date().toISOString(); monitor.lastCheckedAt = checked;
  try {
    const response = await fetch(monitor.url, { headers: { Accept: "application/rss+xml, application/atom+xml, application/json, text/html" }, signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`Source returned HTTP ${response.status}.`);
    const body = await response.text(); const kind = detectKind(response.headers.get("content-type") ?? "", monitor.url, monitor.kind); const items = parseItems(body, kind, monitor.url);
    const personal = readMediaExperience(ownerId).items;
    const overview = await readAssistantOverview(ownerId);
    const archiveSignals = [
      ...overview.recommendations.map((item) => item.title),
      ...overview.groups.map((item) => item.title),
      ...overview.personalizedBriefing.map((item) => item.title),
    ];
    const scoreDiscovery = (title: string) => {
      const normalized = normalize(title);
      const related = personal.filter((item) => normalized.includes(normalize(item.title)) || Boolean(item.seriesTitle && normalized.includes(normalize(item.seriesTitle))));
      const archiveRelated = archiveSignals.filter((signal) => normalized.includes(normalize(signal)) || normalize(signal).includes(normalized));
      const rating = Number(title.match(/(?:⭐|rating\s*)(\d+(?:\.\d+)?)/i)?.[1] ?? NaN);
      const year = Number(title.match(/\b(20\d{2})\b/)?.[1] ?? NaN);
      const active = related.some((item) => item.isNextEpisode || item.status === "in_progress");
      const reasons = [...(related.length ? ["related to your viewing evidence"] : []), ...(archiveRelated.length ? [`related to archive evidence: ${archiveRelated.slice(0, 3).join(", ")}`] : []), ...(active ? ["related series is active or has a next episode"] : []), ...(Number.isFinite(rating) && rating >= 7 ? [`public rating signal: ${rating}/10`] : []), ...(Number.isFinite(year) && year >= new Date().getFullYear() - 1 ? ["recent release-year signal"] : [])];
      return { score: (related.length ? 60 : 0) + (archiveRelated.length ? 50 : 0) + (active ? 25 : 0) + (Number.isFinite(rating) && rating >= 7 ? 15 : 0) + (Number.isFinite(year) && year >= new Date().getFullYear() - 1 ? 10 : 0), reasons };
    };
    const matched = items.flatMap((item) => {
      const targets = monitor.targets.filter((target) => normalize(item.title).includes(normalize(target.title)));
      if (targets.length) return targets.map((target) => ({ ...item, matchedTarget: target.title, discoveryScore: 100, discoveryReasons: ["matched configured watch target"] }));
      if (monitor.discovery) { const scored = scoreDiscovery(item.title); if (scored.score >= 60) return [{ ...item, matchedTarget: "autonomous discovery", discoveryScore: scored.score, discoveryReasons: scored.reasons }]; }
      return [];
    });
    const fingerprint = matched.map((item) => `${item.title}|${item.url ?? ""}`).join("\n"); const isNew = fingerprint !== monitor.lastFingerprint;
    const notifications: MonitorNotification[] = [];
    if (isNew && matched.length) for (const item of matched) notifications.push({ id: randomUUID(), monitorId: monitor.id, ownerId, title: item.title, matchedTarget: item.matchedTarget, url: item.url, evidence: [...item.evidence, ...item.discoveryReasons, `discovery score: ${item.discoveryScore}`], firstSeenAt: checked, read: false });
    monitor.lastFingerprint = fingerprint; monitor.lastSuccessfulCheckAt = checked; monitor.lastError = null; monitor.updatedAt = checked; store.notifications.push(...notifications); await writeStore(settings, store);
    return { monitor, matched, notifications, sourceKind: kind, checkedAt: checked };
  } catch (error) { monitor.lastError = error instanceof Error ? error.message : "Source check failed."; monitor.updatedAt = checked; await writeStore(settings, store); throw error; }
}
export async function deleteSourceMonitor(ownerId: string, id: string, settings: SettingsRecord) { const store = await readStore(settings); const before = store.monitors.length; store.monitors = store.monitors.filter((m) => !(m.ownerId === ownerId && m.id === id)); if (store.monitors.length === before) throw new Error("Source monitor not found."); await writeStore(settings, store); }

export function startSourceMonitorPolling() {
  const intervalMs = Math.max(60_000, Number(process.env.SOURCE_MONITOR_POLL_MS ?? 300_000));
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const settings = (await import("../lib/archive-db")).readSettings();
      const store = await readStore(settings);
      const now = Date.now();
      for (const monitor of store.monitors.filter((item) => item.enabled)) {
        const last = monitor.lastCheckedAt ? Date.parse(monitor.lastCheckedAt) : 0;
        if (!last || now - last >= monitor.intervalMinutes * 60_000) {
          await checkSourceMonitor(monitor.ownerId, monitor.id, settings).catch(() => undefined);
        }
      }
    } finally { running = false; }
  };
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref?.();
  void tick();
  return () => clearInterval(timer);
}

import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import type { SettingsRecord } from "../lib/archive-db";
import { buildArchiveOriginResearch, compareArchiveOrderingSnapshots, type ArchiveOrderingSnapshotItem, type MediaExperienceItem } from "./media-experience";

type Baseline = { ownerId: string; updatedAt: string; collections: Record<string, ArchiveOrderingSnapshotItem[]> };
type Store = { baselines: Baseline[] };

function pathFor(settings: SettingsRecord) { return join(settings.dataDirectory, "archive-ordering-baselines.json"); }
async function readStore(settings: SettingsRecord): Promise<Store> {
  try { const value = JSON.parse(await fs.readFile(pathFor(settings), "utf8")) as Store; return Array.isArray(value.baselines) ? value : { baselines: [] }; }
  catch { return { baselines: [] }; }
}
async function writeStore(settings: SettingsRecord, value: Store) {
  const path = pathFor(settings); await fs.mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`; await fs.writeFile(temporary, JSON.stringify(value, null, 2), "utf8"); await fs.rename(temporary, path);
}

function snapshots(items: MediaExperienceItem[]) {
  const collections = new Map<string, ArchiveOrderingSnapshotItem[]>();
  for (const item of items) {
    if (item.mediaOrigin !== "youtube_channel_archive" || item.itemType !== "episode" || !item.seriesTitle || item.episodeNumber === null || !item.releaseDate || !Number.isFinite(Date.parse(item.releaseDate))) continue;
    const values = collections.get(item.seriesTitle) ?? [];
    values.push({ key: item.key, episodeNumber: item.episodeNumber, releaseDate: item.releaseDate });
    collections.set(item.seriesTitle, values);
  }
  return Object.fromEntries([...collections.entries()].map(([key, values]) => [key, [...new Map(values.map((value) => [`${value.episodeNumber}:${value.releaseDate}`, value])).values()]]));
}

/** Persist only ordering evidence outside the recovered archive database. */
export async function recordArchiveOrderingBaseline(ownerId: string, items: MediaExperienceItem[], settings: SettingsRecord) {
  const store = await readStore(settings);
  const previous = store.baselines.find((baseline) => baseline.ownerId === ownerId);
  const current = snapshots(items);
  const comparisons = Object.entries(current).map(([collection, values]) => compareArchiveOrderingSnapshots(collection, previous?.collections[collection] ?? [], values));
  const next: Baseline = { ownerId, updatedAt: new Date().toISOString(), collections: current };
  const withoutOwner = store.baselines.filter((baseline) => baseline.ownerId !== ownerId);
  await writeStore(settings, { baselines: [...withoutOwner, next] });
  return { baselineUpdatedAt: next.updatedAt, firstObservation: !previous, comparisons };
}

import { accessSync, constants, existsSync, statfsSync, mkdirSync } from "node:fs";
import { basename, relative, resolve, sep } from "node:path";
import type { SettingsRecord } from "../lib/archive-db";
import { expandPath } from "../lib/expand-path";

export type ArchiveMediaType = "movie" | "tv";

export type ArchiveVolume = {
  id: string;
  label: string;
  mediaType: ArchiveMediaType;
  path: string;
  exists: boolean;
  writable: boolean;
  freeBytes: number | null;
};

const WINDOWS_VOLUMES = [
  {
    id: "d-movies",
    label: "D: Movies",
    mediaType: "movie" as const,
    path: "D:\\Movies",
  },
  {
    id: "d-tv",
    label: "D: Tv Shows",
    mediaType: "tv" as const,
    path: "D:\\Tv Shows",
  },
  {
    id: "e-movies",
    label: "E: Movies",
    mediaType: "movie" as const,
    path: "E:\\Movies",
  },
  {
    id: "e-tv",
    label: "E: Tv Shows",
    mediaType: "tv" as const,
    path: "E:\\Tv Shows",
  },
];

function configuredArchivePaths(settings: SettingsRecord): string[] {
  const value = settings.archiveDirectory?.trim() ?? "";

  if (!value) return [];

  try {
    const parsed = JSON.parse(value);

    if (Array.isArray(parsed)) {
      return parsed.filter(
        (item): item is string =>
          typeof item === "string" && item.trim().length > 0,
      );
    }
  } catch {
    // Fall through to legacy newline/semicolon parsing.
  }

  return value
    .split(/\r?\n|;/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function inferMediaTypeFromPath(path: string): ArchiveMediaType {
  const normalized = path.replace(/\\/g, "/");

  return /(^|\/)tv shows?(\/|$)/i.test(normalized)
    ? "tv"
    : "movie";
}

function describeVolume(
  id: string,
  label: string,
  mediaType: ArchiveMediaType,
  path: string,
): ArchiveVolume {
  const expanded = expandPath(path);
  const exists = existsSync(expanded);

  let writable = false;
  let freeBytes: number | null = null;

  if (exists) {
    try {
      accessSync(expanded, constants.W_OK);
      writable = true;

      const stats = statfsSync(expanded);
      freeBytes = Number(stats.bavail) * Number(stats.bsize);
    } catch {
      // Volume exists but storage information could not be queried.
    }
  }

  return {
    id,
    label,
    mediaType,
    path: expanded,
    exists,
    writable,
    freeBytes,
  };
}

export function getArchiveVolumes(
  settings: SettingsRecord,
): ArchiveVolume[] {
  const configured = configuredArchivePaths(settings);

  if (configured.length > 0) {
    return configured.map((path, index) => {
      const mediaType = inferMediaTypeFromPath(path);

      return describeVolume(
        `configured-${index}`,
        basename(path),
        mediaType,
        path,
      );
    });
  }

  if (process.platform === "win32") {
    return WINDOWS_VOLUMES.map((volume) =>
      describeVolume(
        volume.id,
        volume.label,
        volume.mediaType,
        volume.path,
      ),
    );
  }

  return [
    describeVolume(
      "archive",
      "Archive",
      "movie",
      settings.archiveDirectory,
    ),
  ];
}

export function getArchiveScanRoots(
  settings: SettingsRecord,
): string[] {
  return Array.from(
    new Set(
      getArchiveVolumes(settings).map((volume) => volume.path),
    ),
  );
}

export function findArchiveVolumeForPath(
  candidate: string,
  settings: SettingsRecord,
): ArchiveVolume | null {
  const target = resolve(expandPath(candidate));

  return (
    getArchiveVolumes(settings).find((volume) => {
      const root = resolve(volume.path);

      return (
        target === root ||
        target.startsWith(`${root}${sep}`)
      );
    }) ?? null
  );
}

export function chooseArchiveVolume(
  settings: SettingsRecord,
  mediaType: ArchiveMediaType,
): ArchiveVolume | null {
  const eligible = getArchiveVolumes(settings)
    .filter(
      (volume) =>
        volume.mediaType === mediaType &&
        volume.exists &&
        volume.writable,
    )
    .sort(
      (left, right) =>
        (right.freeBytes ?? -1) -
        (left.freeBytes ?? -1),
    );

  return eligible[0] ?? null;
}

export function ensureArchiveVolume(volume: ArchiveVolume) {
  if (!existsSync(volume.path)) {
    mkdirSync(volume.path, { recursive: true });
  }

  try {
    accessSync(volume.path, constants.W_OK);
  } catch {
    throw new Error(
      `Archive destination is not writable: ${volume.path}`,
    );
  }
}

export function isArchivePathWithin(
  candidate: string,
  root: string,
): boolean {
  const target = resolve(expandPath(candidate));
  const base = resolve(expandPath(root));

  const normalizedTarget =
    process.platform === "win32"
      ? target.toLowerCase()
      : target;

  const normalizedBase =
    process.platform === "win32"
      ? base.toLowerCase()
      : base;

  return (
    normalizedTarget === normalizedBase ||
    normalizedTarget.startsWith(`${normalizedBase}${sep}`)
  );
}

export function relativeArchivePath(
  filePath: string,
  volume: ArchiveVolume,
): string {
  return relative(volume.path, resolve(expandPath(filePath)));
}
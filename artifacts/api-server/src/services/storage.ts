import { accessSync, constants, existsSync, statSync, statfsSync, mkdirSync, promises as fs } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, relative, resolve, sep } from "node:path";
import type { SettingsRecord } from "../lib/archive-db";

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

/**
 * The one user-path rule the whole server shares.
 *
 * `~` has to resolve through the OS, not through `process.env.HOME`: a plain
 * Windows PowerShell has `USERPROFILE` but no `HOME`, so the previous
 * `process.env.HOME ?? process.cwd()` fallback silently pointed `~/ARCHIVE/...`
 * defaults at whatever directory the server happened to be started from - which
 * for `pnpm --filter` is the package folder inside the repository. Both `~/` and
 * `~\` are accepted because an operator types whichever separator the shell
 * autocompletes.
 */
export function expandUserPath(value: string) {
  const trimmed = value.trim();
  if (trimmed === "~") return resolve(homedir());
  // `~/` and `~\` both mean "home", because an operator types whichever
  // separator the shell autocompletes.
  if (/^~[\\/]/.test(trimmed)) return resolve(homedir(), trimmed.slice(2));
  return resolve(trimmed);
}

function expandPath(value: string) {
  return expandUserPath(value);
}

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
  const candidates = getArchiveVolumes(settings).filter(
    (volume) => volume.mediaType === mediaType,
  );
  const eligible = candidates
    .filter((volume) => volume.exists && volume.writable)
    .sort(
      (left, right) =>
        (right.freeBytes ?? -1) -
        (left.freeBytes ?? -1),
    );

  if (eligible[0]) return eligible[0];

  // A configured-but-missing volume is treated as creatable: prepareDownload
  // calls ensureArchiveVolume, which creates the root and then re-verifies
  // writability. Volumes that exist but are unwritable are still rejected.
  return candidates.find((volume) => !volume.exists) ?? null;
}

export function ensureArchiveVolume(volume: ArchiveVolume) {
  if (!existsSync(volume.path)) {
    try {
      mkdirSync(volume.path, { recursive: true });
    } catch (error) {
      throw new Error(
        `Archive destination volume could not be created: ${volume.path} (${error instanceof Error ? error.message : "unknown error"})`,
      );
    }
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

/**
 * Move a media file into place, across a volume boundary if it has to.
 *
 * `rename` is the right primitive - it is atomic and it never duplicates a
 * multi-gigabyte file - but it cannot cross a device, and a desktop archive
 * normally lives on a different drive than the staging directory: `C:\Users\…
 * \ARCHIVE\tmp` to `D:\Movies` fails outright on Windows with `EPERM` and on
 * POSIX with `EXDEV`. Falling back to copy-then-remove only when the two paths
 * are provably on different filesystems keeps the fast path atomic, and keeps a
 * genuine permission or sharing violation (Plex holding a file open, for
 * example) an error instead of an accidental duplicate.
 *
 * The copy is written next to its final name with a `.move-part` extension, so a
 * crash mid-copy cannot be picked up as media by the scanner, then verified by
 * byte count, then renamed into place. `archive-operations` guarantees the
 * destination is free before calling this; that check is repeated here because a
 * second process can win the race while the copy is running.
 */
export async function moveFileIntoPlace(
  sourcePath: string,
  targetPath: string,
): Promise<"renamed" | "copied"> {
  let sourceStat;
  try {
    await fs.rename(sourcePath, targetPath);
    return "renamed";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "";
    sourceStat = await fs.stat(sourcePath).catch(() => null);
    // A destination whose parent directory does not exist yet fails with ENOENT
    // before the kernel ever gets to complain about the device boundary, so a
    // missing destination directory on a *different* device is a cross-volume
    // move too. When the source itself is gone, none of this applies.
    const boundaryCode = code === "EXDEV" || code === "EPERM" || code === "EACCES" || (code === "ENOENT" && sourceStat !== null);
    if (!boundaryCode || !isCrossDevice(sourcePath, targetPath)) {
      throw error;
    }
  }

  const partialPath = `${targetPath}.move-part`;
  if (!sourceStat) throw new Error(`The file to be moved no longer exists: ${sourcePath}`);
  try {
    await fs.mkdir(dirname(targetPath), { recursive: true });
    await fs.copyFile(sourcePath, partialPath, constants.COPYFILE_EXCL);
    const copiedStat = await fs.stat(partialPath);
    if (copiedStat.size !== sourceStat.size) {
      throw new Error(
        `The cross-volume copy was ${copiedStat.size} bytes but the source is ${sourceStat.size}; the partial copy was discarded and nothing was moved.`,
      );
    }
    try {
      await fs.lstat(targetPath);
      throw new Error("The destination appeared while the copy was running; the copy was discarded and nothing was moved.");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await fs.rename(partialPath, targetPath);
  } catch (error) {
    await fs.rm(partialPath, { force: true });
    throw error;
  }

  try {
    await fs.unlink(sourcePath);
  } catch (error) {
    // The archive already holds the copy; the staged original is merely a
    // duplicate the scanner will report as an exact match. Deleting the
    // destination here would destroy the only good copy.
    const message = error instanceof Error ? error.message : "the original file could not be removed";
    throw new Error(
      `The file is in place at ${targetPath}, but the original could not be removed (${message}). The next scan reports it as an exact duplicate.`,
    );
  }
  return "copied";
}

/**
 * Whether two paths sit on different devices, which is the only condition under
 * which a failed rename should become a copy. `stat().dev` is the ID of the
 * device containing a path on POSIX and the volume/drive identity on Windows, so
 * one comparison covers `C:\Users\…` to `D:\Movies` and an overlay-to-tmpfs
 * mount equally well. Non-existent paths (a destination directory that is about
 * to be created) are resolved by walking up to the nearest existing ancestor.
 */
function deviceOf(path: string): number | null {
  let candidate = path;
  for (let depth = 0; depth < 16; depth += 1) {
    try {
      return statSync(candidate).dev;
    } catch {
      const parent = dirname(candidate);
      if (parent === candidate) return null;
      candidate = parent;
    }
  }
  return null;
}

function isCrossDevice(left: string, right: string) {
  const leftDevice = deviceOf(left);
  const rightDevice = deviceOf(right);
  if (leftDevice === null || rightDevice === null) {
    // Unknown device information is not evidence of a boundary, so the caller
    // rethrows the original rename error rather than starting a copy.
    return false;
  }
  return leftDevice !== rightDevice;
}

export function relativeArchivePath(
  filePath: string,
  volume: ArchiveVolume,
): string {
  return relative(volume.path, resolve(expandPath(filePath)));
}
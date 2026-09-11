/**
 * Tests for the path and move rules the desktop runtime depends on.
 *
 * These are the behaviours that differ between a POSIX CI box and the Windows
 * machine this application is actually installed on: where `~` resolves, what a
 * legal filename may be, which file counts as a finished download, and what
 * happens when a promotion has to cross a volume boundary. The cross-device move
 * test runs for real whenever the machine has a second filesystem reachable at a
 * standard mount point, and skips itself otherwise rather than asserting on a
 * mocked `rename`.
 */

import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { mkdtemp, mkdir, readdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { expandUserPath, isArchivePathWithin, moveFileIntoPlace } from "../src/services/storage";
import { sanitizeFilename } from "../src/services/media";
import { findFinishedDownloadFile } from "../src/services/download-engine";

const testRoot = process.env.ARCHIVE_TEST_ROOT;
if (!testRoot) throw new Error("ARCHIVE_TEST_ROOT is required.");

async function scratch(name: string) {
  const directory = await mkdtemp(join(testRoot, name));
  return directory;
}

/**
 * A directory on a different device than the test root, when one exists. POSIX
 * reports `stat.dev` per filesystem, Windows per drive, so this finds the same
 * kind of boundary as `C:\Users\…\tmp` to `D:\Movies`.
 */
async function otherDeviceDirectory(): Promise<string | null> {
  const base = await scratch("cross-device");
  const homeDevice = statSync(base).dev;
  for (const candidate of ["/dev/shm", "/run", "/var/tmp", "/tmp"]) {
    try {
      if (statSync(candidate).dev === homeDevice) continue;
      const probe = join(candidate, `archive-assistant-intake-probe-${process.pid}`);
      await mkdir(probe, { recursive: true });
      writeFileSync(join(probe, "probe.txt"), "probe");
      if (readFileSync(join(probe, "probe.txt"), "utf8") !== "probe") continue;
      return probe;
    } catch {
      // Unavailable or read-only: try the next candidate.
    }
  }
  return null;
}

describe("desktop path and move safety", { concurrency: false }, () => {
  test("a leading ~ resolves through the OS, not through a possibly absent HOME variable", () => {
    // The regression this pins: `process.env.HOME ?? process.cwd()` silently
    // placed ~/ARCHIVE defaults inside the repository on a plain Windows shell,
    // where USERPROFILE is set and HOME is not.
    const originalHome = process.env.HOME;
    try {
      delete process.env.HOME;
      assert.equal(expandUserPath("~/ARCHIVE/library"), resolve(homedir(), "ARCHIVE/library"));
      assert.equal(expandUserPath("~"), resolve(homedir()));
    } finally {
      if (originalHome !== undefined) process.env.HOME = originalHome;
    }

    if (process.platform === "win32") {
      // The backslash form is what PowerShell autocompletes.
      assert.equal(expandUserPath("~\\ARCHIVE\\library"), resolve(homedir(), "ARCHIVE", "library"));
    }

    assert.equal(expandUserPath("  ~/ARCHIVE/tmp  "), resolve(homedir(), "ARCHIVE/tmp"));
    assert.equal(expandUserPath("/srv/archive"), resolve("/srv/archive"));
    assert.equal(expandUserPath("relative/folder"), resolve("relative/folder"));
  });

  test("containment is judged on the resolved path, so a collapsed traversal cannot escape", () => {
    // The containment rule is what refuses a mutation that would escape a volume.
    // A path that walks out and back in again is still inside once resolved, and
    // the separate traversal guard in archive-operations is what rejects the
    // `..` segment itself - both statements are pinned so neither rule can be
    // quietly weakened into the other.
    assert.equal(isArchivePathWithin("/srv/archive/Movies/a.mkv", "/srv/archive"), true);
    assert.equal(isArchivePathWithin("/srv/other/a.mkv", "/srv/archive"), false);
    assert.equal(isArchivePathWithin("/srv/archive/Movies/../Secret/a.mkv", "/srv/archive"), true);
    assert.equal(isArchivePathWithin("/srv/archive/../secrets/a.txt", "/srv/archive"), false);
  });

  test("a reserved Windows device name is never produced for a media file", () => {
    // Windows refuses to create CON, PRN, AUX, NUL, COM1-9 and LPT1-9 with any
    // extension, and "Con" is a plausible title for real media.
    for (const reserved of ["Con", "nul", "COM1", "LPT9", "Aux.mkv"]) {
      const filename = sanitizeFilename(reserved, "mkv");
      const stem = filename.split(".")[0]?.toLowerCase() ?? "";
      assert.doesNotMatch(
        stem,
        /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/,
        `"${reserved}" sanitised to the reserved name "${filename}"`,
      );
    }

    const legalised = sanitizeFilename('House: "Season 1" <2024>.mkv', "mkv");
    assert.doesNotMatch(legalised, /[<>:"|?*\\/]/, `"${legalised}" still contains a character Windows rejects`);
    assert.match(legalised, /\.mkv$/);
    assert.equal(sanitizeFilename("Con", "mkv"), "Con_.mkv");
    // A name ending in a dot or a space is silently mangled by Windows Explorer.
    assert.equal(sanitizeFilename("Trailing Dots and Spaces.  ", "mp4"), "Trailing Dots and Spaces.mp4");
    assert.equal(sanitizeFilename("", "mkv"), "download.mkv");
    assert.ok(sanitizeFilename("x".repeat(400), "mkv").length <= 184);
  });

  test("only the finished file counts, never a per-format fragment", async () => {
    const directory = await scratch("finished");
    const expected = "The.Long.Show.2024.1080p.mkv";
    await writeFile(join(directory, `${expected}.part`), "still downloading");
    await writeFile(join(directory, "The.Long.Show.2024.1080p.f140.mkv"), "audio only fragment");
    await writeFile(join(directory, "The.Long.Show.2024.1080p.info.json"), "{}");

    await assert.rejects(
      () => findFinishedDownloadFile(directory, expected),
      /no finished/i,
      "fragments and part files must not be promoted as the finished encode",
    );

    // The exact name wins as soon as it exists.
    writeFileSync(join(directory, expected), "the real file");
    assert.equal(await findFinishedDownloadFile(directory, expected), join(directory, expected));

    // A same-stem, same-container file is accepted when the exact name differs
    // only in case, which is what a container merge can leave behind.
    const second = await scratch("finished-alias");
    await writeFile(join(second, "Alias.2024.MKV"), "merged output");
    // The path returned is the one that exists on disk, casing and all: on a
    // case-sensitive filesystem the caller cannot be handed a name it cannot
    // open, which is exactly what the previous `join(dir, expected)` shape did.
    assert.equal(await findFinishedDownloadFile(second, "Alias.2024.mkv"), join(second, "Alias.2024.MKV"));
  });

  test("a move within one volume stays an atomic rename", async () => {
    const directory = await scratch("same-device");
    const source = join(directory, "source.mkv");
    const target = join(directory, "target.mkv");
    writeFileSync(source, "payload");

    assert.equal(await moveFileIntoPlace(source, target), "renamed");
    assert.equal(readFileSync(target, "utf8"), "payload");
    assert.throws(() => statSync(source), "the source slot must be empty after a rename");
    assert.deepEqual((await readdir(directory)).sort(), ["target.mkv"]);
  });

  test("a move across volumes copies, verifies, and leaves no partial file behind", async (t) => {
    const remote = await otherDeviceDirectory();
    if (!remote) {
      t.skip("no second filesystem is mounted, so a real cross-device move cannot be exercised");
      return;
    }

    const local = await scratch("xdev-local");
    const source = join(local, "staged.mkv");
    const targetDirectory = join(remote, "archive", "Movies", "Shown (2024)");
    const target = join(targetDirectory, "Shown (2024).mkv");
    const payload = "cross-volume-payload".repeat(4096);
    writeFileSync(source, payload);

    assert.equal(
      statSync(source).dev !== statSync(remote).dev,
      true,
      "the fixture must actually straddle a device boundary for this to mean anything",
    );

    const outcome = await moveFileIntoPlace(source, target);
    assert.equal(outcome, "copied", "a cross-device move must not claim to have renamed");
    assert.equal(readFileSync(target, "utf8"), payload, "every byte has to arrive");
    assert.throws(() => statSync(source), "the staged original is removed only after the copy lands");
    assert.equal(
      (await readdir(targetDirectory)).filter((entry) => entry.endsWith(".move-part")).length,
      0,
      "no partial copy may survive a successful move",
    );
  });

  test("a cross-volume move refuses to overwrite and keeps the source intact", async (t) => {
    const remote = await otherDeviceDirectory();
    if (!remote) {
      t.skip("no second filesystem is mounted");
      return;
    }

    const local = await scratch("xdev-collide");
    const source = join(local, "clone.mkv");
    writeFileSync(source, "new bytes from staging");

    // The collision has to sit on the other filesystem, otherwise the rename
    // succeeds and the copy path is never exercised.
    const remoteTargetDirectory = join(remote, "collisions");
    await mkdir(remoteTargetDirectory, { recursive: true });
    const remoteTarget = join(remoteTargetDirectory, "clone.mkv");
    writeFileSync(remoteTarget, "existing archive copy");

    await assert.rejects(() => moveFileIntoPlace(source, remoteTarget), /copy was running|already exists|discarded/i);
    assert.equal(readFileSync(source, "utf8"), "new bytes from staging", "a refused move must not consume the only new copy");
    assert.equal(readFileSync(remoteTarget, "utf8"), "existing archive copy");
    assert.equal(
      (await readdir(remoteTargetDirectory)).some((entry) => entry.endsWith(".move-part")),
      false,
      "the discarded partial copy has to be cleaned up",
    );
  });

  test("the intake queue's own containment rule matches the scanner's", () => {
    const volume = mkdtempSync(join(testRoot, "intake-volume"));
    assert.equal(isArchivePathWithin(join(volume, "Movies", "a.mkv"), volume), true);
    assert.equal(isArchivePathWithin(join(testRoot, "elsewhere", "a.mkv"), volume), false);
  });
});

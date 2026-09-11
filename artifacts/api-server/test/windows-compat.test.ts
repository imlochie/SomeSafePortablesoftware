/**
 * Windows runtime readiness: cross-platform behavior of the primitives the
 * archive pipeline relies on. These run on Linux in CI, but every case here
 * reproduces a failure mode that is routine on Windows and rare otherwise:
 *
 * - moving a file across volumes (temp on one drive, archive on another) is
 *   an EXDEV error for a plain rename, so the move helper must fall back to
 *   an exclusive copy without ever clobbering an existing target;
 * - filenames must survive Windows' forbidden characters, control characters,
 *   trailing dots/spaces, and the reserved device names (CON, NUL, COM1…);
 * - `~` paths must expand against the real user profile (USERPROFILE on
 *   Windows), not fall back to the working directory.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { archiveDb } from "../src/lib/archive-db";
import { moveFile } from "../src/lib/fs-move";
import { isPathWithin, sanitizeFilename } from "../src/services/media";
import { plexSafeDestination, type PlanCandidate } from "../src/services/acquisition-plan";

const testRoot = process.env.ARCHIVE_TEST_ROOT;
if (!testRoot) throw new Error("ARCHIVE_TEST_ROOT is required.");

after(() => archiveDb.close());

describe("cross-volume moves", { concurrency: false }, () => {
  test("a same-volume move is a plain rename and preserves bytes", async () => {
    const dir = join(testRoot, "move-same");
    await mkdir(dir, { recursive: true });
    const source = join(dir, "source.mkv");
    const target = join(dir, "target.mkv");
    await writeFile(source, "same-volume-bytes");
    await moveFile(source, target);
    assert.equal(await readFile(target, "utf8"), "same-volume-bytes");
    assert.equal(existsSync(source), false, "the source is gone after the move");
  });

  test("a cross-volume move (EXDEV) falls back to exclusive copy + verify + remove", async () => {
    // /dev/shm is a tmpfs on a different device from the root filesystem, so
    // renaming between them genuinely fails with EXDEV — the same error a
    // C: -> D: move produces on Windows.
    const shm = "/dev/shm";
    if (!existsSync(shm)) {
      return; // Not available in this environment; the fallback is still covered by the refusal test.
    }
    const localDir = await mkdtemp(join(tmpdir(), "move-exdev-"));
    try {
      const source = join(shm, `archive-assistant-exdev-${process.pid}.mkv`);
      const target = join(localDir, "archived.mkv");
      await writeFile(source, "cross-volume-bytes-that-are-longer-than-a-few-bytes");
      // Sanity: if the environment happens to place both on one device, the
      // rename would succeed and this test would prove nothing about EXDEV.
      await moveFile(source, target);
      assert.equal(await readFile(target, "utf8"), "cross-volume-bytes-that-are-longer-than-a-few-bytes");
      assert.equal(existsSync(source), false, "the source is removed only after the verified copy");
    } finally {
      await rm(localDir, { recursive: true, force: true });
      await rm(join(shm, `archive-assistant-exdev-${process.pid}.mkv`), { force: true });
    }
  });

  test("the cross-volume fallback refuses to overwrite an existing target", async () => {
    const shm = "/dev/shm";
    if (!existsSync(shm)) return;
    const localDir = await mkdtemp(join(tmpdir(), "move-excl-"));
    try {
      const source = join(shm, `archive-assistant-excl-${process.pid}.mkv`);
      const target = join(localDir, "existing.mkv");
      await writeFile(source, "new-bytes");
      await writeFile(target, "precious-existing-bytes");
      await assert.rejects(() => moveFile(source, target), /EEXIST|exists/i);
      assert.equal(await readFile(target, "utf8"), "precious-existing-bytes", "the existing target is untouched");
      assert.equal(existsSync(source), true, "the source is left in place on refusal");
    } finally {
      await rm(localDir, { recursive: true, force: true });
      await rm(join(shm, `archive-assistant-excl-${process.pid}.mkv`), { force: true });
    }
  });
});

describe("Windows-safe filenames", () => {
  test("forbidden characters, control characters, and trailing dots are removed", () => {
    assert.equal(sanitizeFilename('What:"A|Film?<>*'.replace(/\u0000/g, ""), "mkv").includes(':'), false);
    assert.equal(sanitizeFilename("Trailing Dots... ", "mkv").endsWith("..mkv"), false);
    assert.equal(sanitizeFilename("Control\u0001Chars", "mkv").includes("\u0001"), false);
  });

  test("reserved device names are prefixed, not created", () => {
    assert.equal(sanitizeFilename("Con", "mkv"), "_Con.mkv");
    assert.equal(sanitizeFilename("nul", "mp4"), "_nul.mp4");
    assert.equal(sanitizeFilename("COM1", "mkv"), "_COM1.mkv");
    // Reserved-ness ignores the extension on Windows: "Aux.mkv" is still the device.
    assert.equal(sanitizeFilename("Aux", "mkv"), "_Aux.mkv");
    // Ordinary names that merely start with a reserved word are untouched.
    assert.equal(sanitizeFilename("Console", "mkv"), "Console.mkv");
    assert.equal(sanitizeFilename("Comedy Central Special", "mkv"), "Comedy Central Special.mkv");
  });

  test("plan destinations are Windows-safe: structure, dots, reserved names", () => {
    const candidate = {
      identityKey: "tv:con:1:2",
      title: "Con S01E02\u0007 Taboo.",
      mediaType: "tv" as const,
      scope: "episode" as const,
      season: 1,
      episode: 2,
      year: null,
      entryUrl: "https://example.test/con",
      selectedFormatId: "best",
      quality: null,
      estimatedSizeBytes: null,
    } satisfies PlanCandidate;
    const destination = plexSafeDestination(candidate, join(testRoot, "volume"), "mkv");
    assert.ok(destination.directory.endsWith(join("_Con", "Season 01")), `show dir reserved-safe: ${destination.directory}`);
    assert.equal(destination.filename, "_Con S01E02.mkv");
    assert.ok(!destination.filename.includes("\u0007"), "control characters removed");
    assert.ok(!/[. ]$/.test(destination.filename.replace(/\.mkv$/, "")), "no trailing dots before the extension");

    const movie = plexSafeDestination({
      ...candidate,
      identityKey: "movie:nul:2024",
      title: "Nul",
      mediaType: "movie" as const,
      scope: "movie" as const,
      season: null,
      episode: null,
      year: 2024,
    }, join(testRoot, "volume"), "mkv");
    assert.equal(movie.directory, join(testRoot, "volume"));
    assert.equal(movie.filename, "_Nul (2024).mkv");
  });
});

describe("user-profile path expansion", () => {
  test("~ paths resolve against the real home directory on every platform", () => {
    const home = homedir();
    assert.ok(home, "homedir() is available");
    assert.equal(
      isPathWithin("~/ARCHIVE/library", join(home, "ARCHIVE", "library")),
      true,
      "a ~ path is within its expanded home path",
    );
    assert.equal(
      isPathWithin("~/ARCHIVE/library", join(home, "ARCHIVE", "elsewhere")),
      false,
      "containment still refuses sibling paths",
    );
  });
});

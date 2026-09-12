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
 *   Windows), not fall back to the working directory, and every module that
 *   resolves a configured path must agree on the result.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { describe, test } from "node:test";
import { moveFile } from "../src/lib/fs-move";
import { expandPath } from "../src/lib/expand-path";
import { escapeReservedName, isPathWithin, sanitizeFilename } from "../src/services/media";

const testRoot = process.env.ARCHIVE_TEST_ROOT;
if (!testRoot) throw new Error("ARCHIVE_TEST_ROOT is required.");

// /dev/shm is a tmpfs on a different device from the root filesystem, so
// renaming between them genuinely fails with EXDEV — the same error a
// C: -> D: move produces on Windows.
const shm = "/dev/shm";
const crossVolumeAvailable = existsSync(shm);

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

  test("a cross-volume move (EXDEV) falls back to exclusive copy + verify + remove", async (t) => {
    if (!crossVolumeAvailable) return t.skip("no second volume available here");
    const localDir = await mkdtemp(join(tmpdir(), "move-exdev-"));
    const source = join(shm, `archive-assistant-exdev-${process.pid}.mkv`);
    try {
      const target = join(localDir, "archived.mkv");
      const payload = "cross-volume-bytes-that-are-longer-than-a-few-bytes";
      await writeFile(source, payload);
      await moveFile(source, target);
      assert.equal(await readFile(target, "utf8"), payload);
      assert.equal(existsSync(source), false, "the source is removed only after the verified copy");
    } finally {
      await rm(localDir, { recursive: true, force: true });
      await rm(source, { force: true });
    }
  });

  test("the cross-volume fallback refuses to overwrite an existing target", async (t) => {
    if (!crossVolumeAvailable) return t.skip("no second volume available here");
    const localDir = await mkdtemp(join(tmpdir(), "move-excl-"));
    const source = join(shm, `archive-assistant-excl-${process.pid}.mkv`);
    try {
      const target = join(localDir, "existing.mkv");
      await writeFile(source, "new-bytes");
      await writeFile(target, "precious-existing-bytes");
      await assert.rejects(() => moveFile(source, target), /EEXIST|exists/i);
      assert.equal(
        await readFile(target, "utf8"),
        "precious-existing-bytes",
        "the existing target is untouched",
      );
      assert.equal(existsSync(source), true, "the source is left in place on refusal");
    } finally {
      await rm(localDir, { recursive: true, force: true });
      await rm(source, { force: true });
    }
  });

  test("a same-volume move still refuses nothing it used to allow (error passthrough)", async () => {
    const dir = join(testRoot, "move-missing");
    await mkdir(dir, { recursive: true });
    await assert.rejects(
      () => moveFile(join(dir, "absent.mkv"), join(dir, "target.mkv")),
      /ENOENT/,
      "a genuinely missing source still surfaces ENOENT rather than being swallowed",
    );
  });
});

describe("Windows-safe filenames", () => {
  test("forbidden characters, control characters, and trailing dots are removed", () => {
    assert.equal(sanitizeFilename('What:"A|Film?<>*', "mkv").includes(":"), false);
    assert.equal(sanitizeFilename('What:"A|Film?<>*', "mkv").includes("|"), false);
    assert.equal(sanitizeFilename("Trailing Dots... ", "mkv").endsWith("..mkv"), false);
    assert.equal(sanitizeFilename("Control\u0001Chars", "mkv").includes("\u0001"), false);
  });

  test("reserved device names are prefixed, not created", () => {
    assert.equal(sanitizeFilename("Con", "mkv"), "_Con.mkv");
    assert.equal(sanitizeFilename("nul", "mp4"), "_nul.mp4");
    assert.equal(sanitizeFilename("COM1", "mkv"), "_COM1.mkv");
    // Reserved-ness ignores the extension on Windows: "Aux.mkv" is still the device.
    assert.equal(sanitizeFilename("Aux", "mkv"), "_Aux.mkv");
    assert.equal(escapeReservedName("PRN.mkv"), "_PRN.mkv");
  });

  test("ordinary names that merely start with a reserved word are untouched", () => {
    assert.equal(sanitizeFilename("Console", "mkv"), "Console.mkv");
    assert.equal(sanitizeFilename("Comedy Central Special", "mkv"), "Comedy Central Special.mkv");
    assert.equal(sanitizeFilename("Nullify", "mkv"), "Nullify.mkv");
    assert.equal(escapeReservedName("Aux Cable Documentary.mkv"), "Aux Cable Documentary.mkv");
  });

  test("an extension is still appended exactly once", () => {
    assert.equal(sanitizeFilename("Movie.mkv", "mkv"), "Movie.mkv");
    assert.equal(sanitizeFilename("Movie", "mkv"), "Movie.mkv");
  });
});

describe("path expansion", () => {
  test("`~/` expands against the real user profile, not the working directory", () => {
    const expanded = expandPath("~/ARCHIVE/tmp");
    assert.ok(isAbsolute(expanded), "the expansion is absolute");
    assert.equal(expanded, join(homedir(), "ARCHIVE", "tmp"));
    assert.ok(
      !expanded.startsWith(join(process.cwd(), "~")),
      "the tilde is never treated as a literal directory name",
    );
  });

  test("relative and absolute values both resolve to absolute paths", () => {
    assert.equal(expandPath("/srv/archive"), resolve("/srv/archive"));
    assert.ok(isAbsolute(expandPath("relative/archive")));
  });

  test("expansion survives HOME being unset, as it is on Windows", () => {
    const previous = process.env.HOME;
    try {
      delete process.env.HOME;
      // homedir() reads the OS user database, so it keeps working without HOME.
      assert.equal(expandPath("~/ARCHIVE"), join(homedir(), "ARCHIVE"));
    } finally {
      if (previous === undefined) delete process.env.HOME;
      else process.env.HOME = previous;
    }
  });

  test("the containment guard agrees with the shared expansion", () => {
    // The guard and the writer must resolve "~/ARCHIVE" identically, or a job
    // writes somewhere the safety check never inspected.
    assert.equal(isPathWithin("~/ARCHIVE/movies/film.mkv", "~/ARCHIVE"), true);
    assert.equal(isPathWithin(join(homedir(), "ARCHIVE", "film.mkv"), "~/ARCHIVE"), true);
    assert.equal(isPathWithin("~/ARCHIVE-other/film.mkv", "~/ARCHIVE"), false);
    assert.equal(isPathWithin("/etc/passwd", "~/ARCHIVE"), false);
  });
});

describe("every file-move call site uses the cross-volume helper", () => {
  // The helper being correct is not enough: a plain `fs.rename` left anywhere
  // in the move path reintroduces the EXDEV crash on a split temp/archive
  // layout. These are the paths that relocate a user's media, so the guard is
  // on the source itself rather than on behavior that only a two-volume
  // machine could exercise.
  const srcRoot = process.env.API_SERVER_SRC;
  if (!srcRoot) throw new Error("API_SERVER_SRC is required.");

  const moveCallSites = [
    "services/download-engine.ts",
    "services/archive-operations.ts",
  ];

  for (const relativePath of moveCallSites) {
    test(`${relativePath} never calls rename directly`, async () => {
      const source = await readFile(join(srcRoot, relativePath), "utf8");
      const directRenames = source.match(/\bfs\.rename\s*\(/g) ?? [];
      assert.deepEqual(
        directRenames,
        [],
        `${relativePath} must move files through moveFile(), which falls back to copy+verify+remove when the source and destination are on different volumes.`,
      );
      assert.match(
        source,
        /\bmoveFile\s*\(/,
        `${relativePath} is expected to relocate files via moveFile().`,
      );
    });
  }
});

describe("path expansion has a single shared implementation", () => {
  // Three modules used to carry their own `expandPath`, and they disagreed:
  // two resolved to absolute, one did not, and all three fell back to the
  // working directory when HOME was unset. A job would then write to one
  // interpretation of "~/ARCHIVE/tmp" while the guard checked another.
  const srcRoot = process.env.API_SERVER_SRC;
  if (!srcRoot) throw new Error("API_SERVER_SRC is required.");

  for (const relativePath of ["services/media.ts", "services/archive.ts", "services/storage.ts"]) {
    test(`${relativePath} imports expandPath instead of redefining it`, async () => {
      const source = await readFile(join(srcRoot, relativePath), "utf8");
      assert.doesNotMatch(
        source,
        /function\s+expandPath\s*\(/,
        `${relativePath} must import expandPath from lib/expand-path rather than defining a local variant.`,
      );
      assert.match(source, /import\s*\{[^}]*\bexpandPath\b[^}]*\}\s*from\s*"\.\.\/lib\/expand-path"/);
    });
  }
});

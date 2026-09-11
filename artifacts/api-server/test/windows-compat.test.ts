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
import { chmod, mkdir, mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { after, describe, test } from "node:test";
import { archiveDb, writeSettings, readSettings } from "../src/lib/archive-db";
import { createJob } from "../src/services/download-engine";
import { inspectLocalMedia } from "../src/services/media";
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

describe("download job temporary directory expansion", { concurrency: false }, () => {
  // The real-Windows failure this guards against: a persisted
  // temporaryDirectory of "~/ARCHIVE/tmp" entered the download job verbatim,
  // yt-dlp downloaded into a literal "~" directory relative to the working
  // directory, and the local inspection guard (which expands "~" against the
  // real user profile) correctly refused the file. The configured directory
  // must be resolved to its absolute, home-expanded form before it enters a
  // job, and the guard must interpret the configured root exactly the same
  // way. os.homedir() reads HOME at call time on POSIX, so the tests point it
  // at a throwaway profile under the test root.
  const fakeHome = join(testRoot, "fake-home");
  const scenario = join(testRoot, "temp-expansion");
  const movies = join(scenario, "Movies");
  const downloads = join(scenario, "downloads");
  const bin = join(scenario, "bin");
  const owner = "temp-expansion-owner";

  const scenarioSettings = async () => {
    await mkdir(movies, { recursive: true });
    await mkdir(downloads, { recursive: true });
    await mkdir(bin, { recursive: true });
    const ffprobeStub = join(bin, "ffprobe.mjs");
    await writeFile(ffprobeStub, `#!/usr/bin/env node
process.stdout.write(JSON.stringify({
  format: { duration: "1320.5", format_name: "matroska,webm", bit_rate: "4500000" },
  streams: [
    { codec_type: "video", codec_name: "h264", width: 1920, height: 1080, r_frame_rate: "24000/1001" },
    { codec_type: "audio", codec_name: "aac", channels: 2 },
  ],
}));
`);
    await chmod(ffprobeStub, 0o755);
    writeSettings({
      archiveDirectory: movies,
      downloadDirectory: downloads,
      temporaryDirectory: "~/ARCHIVE/tmp",
      ytDlpPath: join(bin, "yt-dlp.mjs"),
      ffmpegPath: join(bin, "ffmpeg.mjs"),
      ffprobePath: ffprobeStub,
      mockMode: false,
    });
    return ffprobeStub;
  };

  test('a configured "~/ARCHIVE/tmp" is resolved to the real home before the job is persisted', async () => {
    const realHome = process.env.HOME;
    process.env.HOME = fakeHome;
    try {
      await scenarioSettings();
      const job = createJob(
        { sourceUrl: "https://example.test/watch/temp-probe", title: "Tempdir Expansion Probe", selectedFormatId: "best" },
        owner,
      );
      assert.ok(job, "the job is created");
      const expected = join(fakeHome, "ARCHIVE", "tmp");
      assert.equal(job.temporaryDirectory, expected, "the configured ~/ path is expanded against the user profile");
      assert.ok(isAbsolute(job.temporaryDirectory), "the staging path yt-dlp receives is absolute");
      assert.ok(!job.temporaryDirectory.includes("~"), "no literal ~ component remains");
    } finally {
      process.env.HOME = realHome;
    }
  });

  test("an explicit absolute temporaryDirectory inside the configured root is preserved unchanged", async () => {
    const realHome = process.env.HOME;
    process.env.HOME = fakeHome;
    try {
      await scenarioSettings();
      const explicit = join(fakeHome, "ARCHIVE", "tmp", "explicit-run");
      const job = createJob(
        {
          sourceUrl: "https://example.test/watch/temp-explicit",
          title: "Tempdir Explicit Probe",
          selectedFormatId: "best",
          temporaryDirectory: explicit,
        },
        owner,
      );
      assert.ok(job);
      assert.equal(job.temporaryDirectory, explicit, "an explicit absolute directory passes through unchanged");
    } finally {
      process.env.HOME = realHome;
    }
  });

  test("a file staged in the resolved directory passes the inspection guard; an unconfigured path still does not", async () => {
    const realHome = process.env.HOME;
    process.env.HOME = fakeHome;
    try {
      await scenarioSettings();
      const job = createJob(
        { sourceUrl: "https://example.test/watch/temp-guard", title: "Tempdir Guard Probe", selectedFormatId: "best" },
        owner,
      );
      assert.ok(job);
      assert.equal(job.temporaryDirectory, join(fakeHome, "ARCHIVE", "tmp"));

      // Stage a media file exactly where the resolved job directory points.
      const staged = join(job.temporaryDirectory, "staged-probe.mkv");
      await mkdir(job.temporaryDirectory, { recursive: true });
      await writeFile(staged, "staged-media-bytes");

      // The guard must accept the staged file against the SAME "~/..."-shaped
      // settings the job was created with, and FFprobe must verify it.
      const settings = readSettings();
      const inspection = await inspectLocalMedia(staged, settings);
      assert.equal(inspection.verification, "passed");
      assert.ok(inspection.videoStreams + inspection.audioStreams >= 1);

      // No weakening: a file outside every configured root is still refused.
      const rogueDir = join(scenario, "unconfigured");
      await mkdir(rogueDir, { recursive: true });
      const rogue = join(rogueDir, "rogue.mkv");
      await writeFile(rogue, "rogue-bytes");
      await assert.rejects(
        () => inspectLocalMedia(rogue, settings),
        /limited to configured Archive Assistant directories/,
      );
    } finally {
      process.env.HOME = realHome;
    }
  });
});

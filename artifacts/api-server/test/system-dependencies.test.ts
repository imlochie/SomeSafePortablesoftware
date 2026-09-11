/**
 * Regression tests for the system dependency probe.
 *
 * The probe is asynchronous because the synchronous variants deadlock for some
 * Windows executables: a configured yt-dlp.exe answers "--version" with
 * ETIMEDOUT under execFileSync and spawnSync with piped stdio, while the same
 * probe through execFile resolves immediately. These tests pin the behavior
 * that matters for the real Windows layout:
 *
 * - a configured ABSOLUTE executable path (e.g. C:\Users\...\yt-dlp.exe —
 *   modeled here as an absolute path, with a space in a directory component,
 *   to a bare executable file) is detected as available with its version;
 * - the FFmpeg capability probe still runs alongside the version probe;
 * - the response keeps validating against the generated API schema;
 * - a broken configuration reports `missing` without hanging anything.
 */
import assert from "node:assert/strict";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { GetSystemDependenciesResponse } from "@workspace/api-zod";
import { archiveDb, writeSettings } from "../src/lib/archive-db";
import { readSystemDependencies } from "../src/routes/system";

const testRoot = process.env.ARCHIVE_TEST_ROOT;
if (!testRoot) throw new Error("ARCHIVE_TEST_ROOT is required.");

after(() => archiveDb.close());

describe("system dependency probe", { concurrency: false }, () => {
  test("configured absolute executable paths are detected through the asynchronous probe", async () => {
    // Model the Windows configuration: absolute paths to bare executables,
    // in a directory with a space (as under C:\Users\lochi\Downloads\...).
    const toolsDir = join(testRoot, "Probe Tools");
    await mkdir(toolsDir, { recursive: true });

    const ytDlp = join(toolsDir, "yt-dlp.exe");
    await writeFile(ytDlp, "#!/usr/bin/env node\nprocess.stdout.write(\"2026.08.19\\n\");\n");
    await chmod(ytDlp, 0o755);

    const ffmpeg = join(toolsDir, "ffmpeg.exe");
    await writeFile(
      ffmpeg,
      [
        "#!/usr/bin/env node",
        "if (process.argv.slice(2).includes(\"-hwaccels\")) {",
        "  process.stdout.write(\"Hardware acceleration methods:\\nd3d11va\\ncuda\\n\");",
        "} else {",
        "  process.stdout.write(\"ffmpeg version 7.1-static-BUILD\\n\");",
        "}",
        "",
      ].join("\n"),
    );
    await chmod(ffmpeg, 0o755);

    const ffprobe = join(toolsDir, "ffprobe.exe");
    await writeFile(ffprobe, "#!/usr/bin/env node\nprocess.stdout.write(\"ffprobe version 7.1-static\\n\");\n");
    await chmod(ffprobe, 0o755);

    writeSettings({ ytDlpPath: ytDlp, ffmpegPath: ffmpeg, ffprobePath: ffprobe });

    const dependencies = await readSystemDependencies();

    // The response schema still validates the probe result unchanged.
    GetSystemDependenciesResponse.parse(dependencies);

    const ytDlpEntry = dependencies.find((entry) => entry.name === "yt-dlp");
    assert.ok(ytDlpEntry, "yt-dlp is probed");
    assert.equal(ytDlpEntry.status, "available");
    assert.equal(ytDlpEntry.version, "2026.08.19");
    assert.equal(ytDlpEntry.command, ytDlp);

    const ffmpegEntry = dependencies.find((entry) => entry.name === "FFmpeg");
    assert.ok(ffmpegEntry, "FFmpeg is probed");
    assert.equal(ffmpegEntry.status, "available");
    assert.match(ffmpegEntry.version ?? "", /7\.1/);
    assert.ok(ffmpegEntry.capabilities.includes("d3d11va"), "hwaccels are parsed");
    assert.ok(ffmpegEntry.capabilities.includes("cuda"));
    assert.ok(
      !ffmpegEntry.capabilities.some((line) => line.includes("Hardware acceleration")),
      "the banner line is filtered out",
    );

    const ffprobeEntry = dependencies.find((entry) => entry.name === "ffprobe");
    assert.ok(ffprobeEntry, "ffprobe is probed");
    assert.equal(ffprobeEntry.status, "available");
    assert.match(ffprobeEntry.version ?? "", /ffprobe version/);

    // Probes run concurrently and the Node.js entry resolves alongside them.
    const nodeEntry = dependencies.find((entry) => entry.name === "Node.js");
    assert.ok(nodeEntry);
    assert.equal(nodeEntry.status, "available");
    assert.match(nodeEntry.version ?? "", /^v\d+\.\d+/);
  });

  test("a missing configured executable reports missing and keeps the schema", async () => {
    writeSettings({ ytDlpPath: join(testRoot, "does-not-exist", "yt-dlp.exe") });

    const dependencies = await readSystemDependencies();
    GetSystemDependenciesResponse.parse(dependencies);

    const ytDlpEntry = dependencies.find((entry) => entry.name === "yt-dlp");
    assert.ok(ytDlpEntry);
    assert.equal(ytDlpEntry.status, "missing");
    assert.equal(ytDlpEntry.version, null);
    assert.deepEqual(ytDlpEntry.capabilities, []);
    assert.equal(ytDlpEntry.detail, "Optional dependency not detected");

    // The SQLite CLI entry degrades to its documented embedded fallback.
    const sqliteEntry = dependencies.find((entry) => entry.name === "SQLite");
    assert.ok(sqliteEntry);
    assert.ok(["not_configured", "available"].includes(sqliteEntry.status));
  });
});

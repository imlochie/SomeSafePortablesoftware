import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { after, describe, test } from "node:test";
import app from "../src/app";
import { archiveDb, readSettings, writeSettings } from "../src/lib/archive-db";
import { readArchiveScan, startArchiveScan } from "../src/services/archive";
import {
  readArchiveScanLiveState,
  subscribeArchiveScanEvents,
  type ArchiveScanEvent,
  type ArchiveScanLiveStateView,
} from "../src/services/scan-events";
import { runtimeConfig } from "../src/lib/runtime-config";

const ownerId = runtimeConfig.localOwnerId;
const otherOwnerId = "user-b";
const testRoot = process.env.ARCHIVE_TEST_ROOT;
const PROBE_DELAY_MS = 90;

if (!testRoot) throw new Error("ARCHIVE_TEST_ROOT is required.");

const KNOWN_EVENT_TYPES = new Set([
  "scan.started",
  "scan.file.discovered",
  "scan.file.started",
  "scan.file.stage",
  "scan.file.completed",
  "scan.file.failed",
  "scan.progress",
  "scan.completed",
  "scan.failed",
]);

const ARCHIVE_SCAN_CONTRACT_KEYS = [
  "status",
  "startedAt",
  "completedAt",
  "lastError",
  "scannedFiles",
  "activeFiles",
  "failedFiles",
  "duplicateCount",
  "missingCount",
  "qualityConflictCount",
  "plexOnlyCount",
  "localOnlyCount",
];

const server: Server = createServer(app);
let baseUrl = "";

after(() => {
  archiveDb.close();
  server.close();
});

async function waitForScanCompletion() {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const state = readArchiveScan(ownerId);
    if (state.status !== "scanning") return state;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Archive scan did not finish.");
}

async function writeFakeFfprobe() {
  const ffprobePath = join(testRoot, "fake-ffprobe.mjs");
  await writeFile(ffprobePath, `#!/usr/bin/env node
import { setTimeout as sleep } from "node:timers/promises";
const file = process.argv.at(-1) ?? "";
await sleep(${PROBE_DELAY_MS});
if (file.includes("Corrupt")) {
  process.stderr.write("invalid media");
  process.exit(1);
}
const is2160 = file.includes("2160");
process.stdout.write(JSON.stringify({
  format: {
    duration: file.includes("Movie") ? "7200.25" : "3600.5",
    bit_rate: is2160 ? "28000000" : "8000000",
    format_name: "matroska,webm"
  },
  streams: [
    { codec_type: "video", codec_name: is2160 ? "hevc" : "h264", width: is2160 ? 3840 : 1920, height: is2160 ? 2160 : 1080, r_frame_rate: "24000/1001" },
    { codec_type: "audio", codec_name: "eac3", channels: 6, tags: { language: "eng" } },
    { codec_type: "subtitle", codec_name: "subrip", tags: { language: "spa" } }
  ]
}));
`);
  await chmod(ffprobePath, 0o755);
  return ffprobePath;
}

async function configureArchive(moviesRoot: string, tvRoot: string, extraRoots: string[] = []) {
  await mkdir(moviesRoot, { recursive: true });
  await mkdir(tvRoot, { recursive: true });
  const ffprobePath = await writeFakeFfprobe();
  writeSettings({
    archiveDirectory: [moviesRoot, tvRoot, ...extraRoots].join("\n"),
    downloadDirectory: join(testRoot, "downloads"),
    temporaryDirectory: join(testRoot, "tmp"),
    ffprobePath,
  });
}

type SseFrame = { event: string; data: string };

function parseSseFrame(raw: string): SseFrame | null {
  let eventName = "message";
  let data = "";
  for (const line of raw.split("\n")) {
    if (line.startsWith(":")) continue;
    if (line.startsWith("event:")) eventName = line.slice(6).trim();
    if (line.startsWith("data:")) data += line.slice(5).trim();
  }
  return data ? { event: eventName, data } : null;
}

type ScanEventsStream = {
  frames: SseFrame[];
  waitForFrame: (predicate: (frame: SseFrame) => boolean, timeoutMs?: number) => Promise<SseFrame>;
  close: () => Promise<void>;
};

async function openScanEventsStream(): Promise<ScanEventsStream> {
  const controller = new AbortController();
  const response = await fetch(`${baseUrl}/api/archive/scan/events`, {
    signal: controller.signal,
    headers: { accept: "text/event-stream" },
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
  assert.match(response.headers.get("cache-control") ?? "", /no-cache/);
  const frames: SseFrame[] = [];
  let pumpDone: Promise<void>;
  const pump = async () => {
    try {
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let boundary = buffer.indexOf("\n\n");
        while (boundary !== -1) {
          const frame = parseSseFrame(buffer.slice(0, boundary));
          if (frame) frames.push(frame);
          buffer = buffer.slice(boundary + 2);
          boundary = buffer.indexOf("\n\n");
        }
      }
    } catch {
      // Aborted streams are expected while testing reconnect behavior.
    }
  };
  pumpDone = pump();
  const waitForFrame = async (predicate: (frame: SseFrame) => boolean, timeoutMs = 15_000) => {
    for (let attempt = 0; attempt < timeoutMs / 10; attempt += 1) {
      const frame = frames.find(predicate);
      if (frame) return frame;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`Timed out waiting for an SSE frame. Received: ${JSON.stringify(frames.slice(0, 20))}`);
  };
  return {
    frames,
    waitForFrame,
    close: async () => {
      controller.abort();
      await pumpDone;
    },
  };
}

describe("archive scan events", { concurrency: false }, () => {
  test("scan events stream the full lifecycle with the scanner's real stages", async () => {
    const moviesRoot = join(testRoot, "events-archive", "movies");
    const tvRoot = join(testRoot, "events-archive", "tv shows");
    await configureArchive(moviesRoot, tvRoot);
    const files = {
      matrix: join(moviesRoot, "The.Matrix.1999.mkv"),
      toyStory: join(moviesRoot, "Toy.Story.1995.mkv"),
      corrupt: join(moviesRoot, "Corrupt.File.2020.mkv"),
      breakingBad: join(tvRoot, "Breaking.Bad.S03E07.mkv"),
      firefly: join(tvRoot, "Firefly.S01E01.mkv"),
    };
    await Promise.all(Object.values(files).map((file) => writeFile(file, "media-bytes")));

    assert.equal(readArchiveScanLiveState(ownerId).status, "idle");

    const events: ArchiveScanEvent[] = [];
    const otherOwnerEvents: ArchiveScanEvent[] = [];
    const unsubscribe = subscribeArchiveScanEvents(ownerId, (event) => events.push(event));
    const unsubscribeOther = subscribeArchiveScanEvents(otherOwnerId, (event) => otherOwnerEvents.push(event));
    try {
      const finalState = await (async () => {
        startArchiveScan(ownerId);
        return waitForScanCompletion();
      })();
      assert.equal(finalState.status, "completed");
      assert.equal(finalState.scannedFiles, 5);
      assert.equal(finalState.failedFiles, 1);
    } finally {
      unsubscribe();
      unsubscribeOther();
    }
    assert.deepEqual(otherOwnerEvents, [], "scan events must not leak across owners");

    const types = events.map((event) => event.type);
    for (const type of types) assert.ok(KNOWN_EVENT_TYPES.has(type), `Unexpected event type: ${type}`);
    assert.equal(types[0], "scan.started");
    assert.equal(types.at(-1), "scan.completed");

    const started = events[0];
    assert.equal(started.type, "scan.started");
    assert.deepEqual(
      [...started.roots].sort(),
      [moviesRoot, tvRoot].sort(),
      "scan.started must report the configured scan roots",
    );
    const sessionId = started.sessionId;
    assert.ok(sessionId);
    for (const event of events) {
      assert.equal(event.sessionId, sessionId, "every event belongs to the scan session");
      assert.ok(event.timestamp);
    }

    const completed = events.at(-1)!;
    assert.equal(completed.type, "scan.completed");
    if (completed.type === "scan.completed") {
      assert.equal(completed.scanned, 5);
      assert.equal(completed.failed, 1);
      assert.equal(completed.discovered, 5);
      assert.ok(completed.durationMs > 0);
      assert.match(completed.lastError ?? "", /1 file that could not be inspected/);
    }

    const positionOf = (predicate: (event: ArchiveScanEvent) => boolean) =>
      events.findIndex(predicate);

    const failedEvent = events.find(
      (event): event is Extract<ArchiveScanEvent, { type: "scan.file.failed" }> =>
        event.type === "scan.file.failed" && event.path === files.corrupt,
    );
    assert.ok(failedEvent, "the corrupt file must produce scan.file.failed");
    assert.ok(failedEvent.error.length > 0);
    assert.equal(failedEvent.filename, "Corrupt.File.2020.mkv");

    for (const path of [files.matrix, files.toyStory, files.breakingBad, files.firefly]) {
      const discovered = positionOf((event) => event.type === "scan.file.discovered" && event.path === path);
      const fileStarted = positionOf((event) => event.type === "scan.file.started" && event.path === path);
      const probe = positionOf((event) => event.type === "scan.file.stage" && event.path === path && event.stage === "probe");
      const register = positionOf((event) => event.type === "scan.file.stage" && event.path === path && event.stage === "register");
      const completedFile = positionOf((event) => event.type === "scan.file.completed" && event.path === path);
      assert.ok(discovered !== -1, `${path} was discovered`);
      assert.ok(fileStarted !== -1, `${path} inspection started`);
      assert.ok(probe !== -1, `${path} was probed`);
      assert.ok(register !== -1, `${path} was registered`);
      assert.ok(completedFile !== -1, `${path} completed`);
      assert.ok(discovered < fileStarted, "discovery precedes inspection");
      assert.ok(fileStarted < probe, "inspection precedes the probe stage");
      assert.ok(probe < register, "the probe stage precedes registration");
      assert.ok(register < completedFile, "registration precedes completion");
      const outcome = events[completedFile] as Extract<ArchiveScanEvent, { type: "scan.file.completed" }>;
      assert.equal(outcome.outcome, "registered");
    }

    const breakingBadStarted = events.find(
      (event): event is Extract<ArchiveScanEvent, { type: "scan.file.started" }> =>
        event.type === "scan.file.started" && event.path === files.breakingBad,
    );
    assert.equal(breakingBadStarted?.mediaType, "tv");
    assert.equal(breakingBadStarted?.root, tvRoot);
    assert.equal(breakingBadStarted?.title, "Breaking.Bad.S03E07");
    const matrixStarted = events.find(
      (event): event is Extract<ArchiveScanEvent, { type: "scan.file.started" }> =>
        event.type === "scan.file.started" && event.path === files.matrix,
    );
    assert.equal(matrixStarted?.mediaType, "movie");

    const progress = events.filter((event) => event.type === "scan.progress") as Array<Extract<ArchiveScanEvent, { type: "scan.progress" }>>;
    assert.ok(progress.length >= 1, "progress events are emitted");
    assert.ok(progress.every((event) => event.discovered >= event.scanned - 1));
    assert.ok(progress.some((event) => event.discoveryComplete), "discovery completion is reported");

    const live = readArchiveScanLiveState(ownerId);
    assert.equal(live.status, "completed");
    assert.equal(live.sessionId, sessionId);
    assert.equal(live.scanned, 5);
    assert.equal(live.failed, 1);
    assert.equal(live.discovered, 5);
    assert.equal(live.currentItem, null, "the current item clears once the scan drains");
    assert.equal(live.activeCount, 0);
  });

  test("live state tracks the current item, its stages, and a bounded recent history", async () => {
    const moviesRoot = join(testRoot, "live-archive", "movies");
    const tvRoot = join(testRoot, "live-archive", "tv shows");
    await configureArchive(moviesRoot, tvRoot);
    const filePaths = Array.from({ length: 12 }, (_, index) =>
      join(moviesRoot, `Live.Movie.${String(index + 1).padStart(2, "0")}.2024.mkv`));
    await Promise.all(filePaths.map((file) => writeFile(file, `live-${basename(file)}`)));

    const observedCurrent: Array<ArchiveScanLiveStateView["currentItem"]> = [];
    const observedProbeStates: string[] = [];
    const unsubscribe = subscribeArchiveScanEvents(ownerId, (event) => {
      const live = readArchiveScanLiveState(ownerId);
      if (event.type === "scan.file.started") {
        observedCurrent.push(live.currentItem);
      }
      if (event.type === "scan.file.stage" && event.stage === "probe") {
        const activeItem = live.activeItems.find((item) => item.path === event.path);
        if (activeItem) observedProbeStates.push(JSON.stringify(activeItem.stages));
      }
    });
    try {
      startArchiveScan(ownerId);
      const finalState = await waitForScanCompletion();
      assert.equal(finalState.status, "completed");
      assert.equal(finalState.scannedFiles, 12);
    } finally {
      unsubscribe();
    }

    assert.ok(observedCurrent.length >= filePaths.length, "every inspected file reports a current item");
    for (const current of observedCurrent) {
      assert.ok(current, "a file start always yields a current item");
      assert.ok(filePaths.includes(current.path));
      assert.ok(current.title.startsWith("Live.Movie."));
      assert.ok(
        current.stages.some((stage) => stage.stage === "inspect" && stage.status === "active"),
        "the inspect stage is active when a file starts",
      );
    }
    for (const stagesJson of observedProbeStates) {
      const stages = JSON.parse(stagesJson) as Array<{ stage: string; status: string }>;
      assert.ok(stages.some((stage) => stage.stage === "inspect" && stage.status === "done"));
      assert.ok(stages.some((stage) => stage.stage === "probe" && stage.status === "active"));
    }

    const live = readArchiveScanLiveState(ownerId);
    assert.equal(live.status, "completed");
    assert.equal(live.recentItems.length, 12, "recent history keeps every scanned file below the bound");
    const recentPaths = new Set(live.recentItems.map((item) => item.path));
    for (const path of filePaths) assert.ok(recentPaths.has(path), `${path} appears in recent history`);
    assert.equal(live.recentItems[0].outcome, "registered");
    assert.ok(live.recentItems[0].completedAt >= live.recentItems.at(-1)!.completedAt, "recent history is newest first");
    for (const item of live.recentItems) {
      assert.ok(item.durationMs === null || item.durationMs >= 0);
      assert.equal(item.error, null);
    }
  });

  test("failed files surface failures, unchanged files skip probing, and recent history stays bounded", async () => {
    const moviesRoot = join(testRoot, "bounded-archive", "movies");
    const tvRoot = join(testRoot, "bounded-archive", "tv shows");
    await configureArchive(moviesRoot, tvRoot);
    const boundedRoot = join(testRoot, "bounded-archive", "extra movies");
    await mkdir(boundedRoot, { recursive: true });
    writeSettings({
      ...readSettings(),
      archiveDirectory: [moviesRoot, tvRoot, boundedRoot].join("\n"),
    });

    const boundedFiles = Array.from({ length: 30 }, (_, index) =>
      join(boundedRoot, `Bounded.Movie.${String(index + 1).padStart(2, "0")}.2023.mkv`));
    const freshFile = join(moviesRoot, "Fresh.Movie.2026.mkv");
    await Promise.all(boundedFiles.map((file) => writeFile(file, `bounded-${basename(file)}`)));
    await writeFile(freshFile, "fresh-media");

    const events: ArchiveScanEvent[] = [];
    const unsubscribe = subscribeArchiveScanEvents(ownerId, (event) => events.push(event));
    try {
      startArchiveScan(ownerId);
      const firstPass = await waitForScanCompletion();
      assert.equal(firstPass.status, "completed");
      assert.equal(firstPass.scannedFiles, 31);
      assert.equal(firstPass.failedFiles, 0);
    } finally {
      unsubscribe();
    }

    const live = readArchiveScanLiveState(ownerId);
    assert.equal(live.recentItems.length, 20, "recent history is capped at 20 items");
    const recentNames = new Set(live.recentItems.map((item) => item.filename));
    assert.equal(recentNames.size, 20, "recent history holds distinct files");
    for (const item of live.recentItems) {
      assert.ok(item.filename.startsWith("Bounded.Movie.") || item.filename === "Fresh.Movie.2026.mkv");
      assert.equal(item.outcome, "registered");
    }

    // Second pass with no changes: files must be reported as unchanged and the
    // probe stage must never fire because the scanner skips FFprobe.
    const secondPassEvents: ArchiveScanEvent[] = [];
    const unsubscribeSecond = subscribeArchiveScanEvents(ownerId, (event) => secondPassEvents.push(event));
    try {
      startArchiveScan(ownerId);
      const secondPass = await waitForScanCompletion();
      assert.equal(secondPass.status, "completed");
      assert.equal(secondPass.scannedFiles, 31);
    } finally {
      unsubscribeSecond();
    }
    assert.ok(
      !secondPassEvents.some((event) => event.type === "scan.file.stage" && event.stage === "probe"),
      "unchanged files must not report a probe stage",
    );
    const completedSecond = secondPassEvents.filter(
      (event): event is Extract<ArchiveScanEvent, { type: "scan.file.completed" }> => event.type === "scan.file.completed",
    );
    assert.equal(completedSecond.length, 31);
    assert.ok(completedSecond.every((event) => event.outcome === "unchanged"));

    // Changing one file must flip exactly that file back to a probe + registration.
    await writeFile(freshFile, "fresh-media-changed");
    const thirdPassEvents: ArchiveScanEvent[] = [];
    const unsubscribeThird = subscribeArchiveScanEvents(ownerId, (event) => thirdPassEvents.push(event));
    try {
      startArchiveScan(ownerId);
      const thirdPass = await waitForScanCompletion();
      assert.equal(thirdPass.status, "completed");
    } finally {
      unsubscribeThird();
    }
    const changedCompleted = thirdPassEvents.filter(
      (event): event is Extract<ArchiveScanEvent, { type: "scan.file.completed" }> =>
        event.type === "scan.file.completed" && event.path === freshFile,
    );
    assert.equal(changedCompleted.length, 1);
    assert.equal(changedCompleted[0].outcome, "registered");
    assert.ok(thirdPassEvents.some(
      (event) => event.type === "scan.file.stage" && event.stage === "probe" && event.path === freshFile,
    ), "the changed file is probed again");
  });

  test("the SSE stream sends an initial snapshot, live events, and reconnects with fresh state", async () => {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (typeof address === "string" || address === null) throw new Error("Expected a TCP listener address.");
    baseUrl = `http://127.0.0.1:${address.port}`;

    const aggregateBefore = await fetch(`${baseUrl}/api/archive/scan`).then((response) => {
      assert.equal(response.status, 200);
      return response.json() as Promise<Record<string, unknown>>;
    });
    assert.deepEqual(
      Object.keys(aggregateBefore).sort(),
      [...ARCHIVE_SCAN_CONTRACT_KEYS].sort(),
      "GET /api/archive/scan keeps its existing response contract",
    );

    const moviesRoot = join(testRoot, "sse-archive", "movies");
    const tvRoot = join(testRoot, "sse-archive", "tv shows");
    await configureArchive(moviesRoot, tvRoot);
    const filePaths = Array.from({ length: 16 }, (_, index) =>
      join(moviesRoot, `Stream.Movie.${String(index + 1).padStart(2, "0")}.2024.mkv`));
    await Promise.all(filePaths.map((file) => writeFile(file, `stream-${basename(file)}`)));

    const first = await openScanEventsStream();
    const snapshotFrame = await first.waitForFrame((frame) => frame.event === "snapshot");
    const snapshot = JSON.parse(snapshotFrame.data) as {
      scan: Record<string, unknown>;
      live: Record<string, unknown>;
    };
    assert.deepEqual(
      Object.keys(snapshot.scan).sort(),
      [...ARCHIVE_SCAN_CONTRACT_KEYS].sort(),
      "the SSE snapshot embeds the unchanged /archive/scan aggregate",
    );
    assert.ok(snapshot.live.sessionId === null || typeof snapshot.live.sessionId === "string");
    assert.equal(snapshot.live.status, "completed");
    assert.ok(Array.isArray(snapshot.live.recentItems));

    const startResponse = await fetch(`${baseUrl}/api/archive/scan`, { method: "POST" });
    assert.equal(startResponse.status, 202);
    const startedAggregate = await startResponse.json() as Record<string, unknown>;
    assert.deepEqual(
      Object.keys(startedAggregate).sort(),
      [...ARCHIVE_SCAN_CONTRACT_KEYS].sort(),
      "POST /api/archive/scan keeps its existing response contract",
    );

    const startedFrame = await first.waitForFrame((frame) => frame.event === "scan.started");
    const startedEvent = JSON.parse(startedFrame.data) as { sessionId: string; roots: string[] };
    assert.ok(startedEvent.sessionId);
    assert.equal(startedEvent.roots.length, 2);

    await first.waitForFrame((frame) => frame.event === "scan.file.discovered");
    await first.close();

    // Reconnect mid-scan: the new connection must immediately receive a
    // snapshot that reflects the in-flight scan, then keep streaming events.
    const second = await openScanEventsStream();
    const reconnectSnapshotFrame = await second.waitForFrame((frame) => frame.event === "snapshot");
    const reconnectSnapshot = JSON.parse(reconnectSnapshotFrame.data) as {
      scan: { status: string };
      live: { status: string; sessionId: string | null; discovered: number; scanned: number };
    };
    assert.equal(reconnectSnapshot.scan.status, "scanning");
    assert.equal(reconnectSnapshot.live.status, "scanning");
    assert.equal(reconnectSnapshot.live.sessionId, startedEvent.sessionId);
    assert.ok(reconnectSnapshot.live.discovered > 0, "the reconnect snapshot shows live discovery progress");

    const completedFrame = await second.waitForFrame((frame) => frame.event === "scan.completed");
    const completedEvent = JSON.parse(completedFrame.data) as {
      scanned: number;
      failed: number;
      discovered: number;
      sessionId: string;
    };
    assert.equal(completedEvent.scanned, 16);
    assert.equal(completedEvent.failed, 0);
    assert.equal(completedEvent.discovered, 16);
    assert.equal(completedEvent.sessionId, startedEvent.sessionId);
    assert.ok(second.frames.some((frame) => frame.event === "scan.file.completed"));
    assert.ok(second.frames.some((frame) => frame.event === "scan.progress"));
    await second.close();

    const finalAggregate = await fetch(`${baseUrl}/api/archive/scan`).then(
      (response) => response.json() as Promise<Record<string, unknown>>,
    );
    assert.equal(finalAggregate.status, "completed");
    assert.equal(finalAggregate.scannedFiles, 16);
  });
});

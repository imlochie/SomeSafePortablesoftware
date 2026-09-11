import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { GetSystemDependenciesResponse } from "@workspace/api-zod";
import { readSettings } from "../src/lib/archive-db";
import { resolveRuntimeConfig } from "../src/lib/runtime-config";
import { getLocalToolPaths } from "../src/services/local-tools";
import {
  dependencyDefinitions,
  detectDependency,
} from "../src/services/system-dependencies";

describe("system dependency status", { concurrency: false }, () => {
  test("always returns schema-valid capability metadata", async () => {
    const dependencies = GetSystemDependenciesResponse.parse(
      dependencyDefinitions.map((dependency) =>
        detectDependency(dependency, readSettings()),
      ),
    );
    assert.equal(dependencies.length, 5);

    for (const dependency of dependencies) {
      assert.ok(Array.isArray(dependency.capabilities));
      if (dependency.name !== "FFmpeg") {
        assert.deepEqual(dependency.capabilities, []);
      }
    }
  });

  test("uses the managed directory when no tool override is supplied", () => {
    const config = resolveRuntimeConfig({
      ARCHIVE_MEDIA_TOOLS_DIR: "/managed/media-tools",
    });
    assert.equal(config.tools.ytDlp, "/managed/media-tools/yt-dlp");
    assert.equal(config.tools.ffmpeg, "/managed/media-tools/ffmpeg");
    assert.equal(config.tools.ffprobe, "/managed/media-tools/ffprobe");
  });

  test("keeps environment tool overrides ahead of the managed directory", () => {
    const config = resolveRuntimeConfig({
      ARCHIVE_MEDIA_TOOLS_DIR: "/managed/media-tools",
      YT_DLP_PATH: "/operator/bin/yt-dlp",
      FFMPEG_PATH: "/operator/bin/ffmpeg",
      FFPROBE_PATH: "/operator/bin/ffprobe",
    });
    assert.deepEqual(config.tools, {
      ytDlp: "/operator/bin/yt-dlp",
      ffmpeg: "/operator/bin/ffmpeg",
      ffprobe: "/operator/bin/ffprobe",
    });
  });

  test("keeps explicit settings overrides ahead of managed tools", () => {
    assert.deepEqual(
      getLocalToolPaths({
        ytDlpPath: "/custom/yt-dlp",
        ffmpegPath: "/custom/ffmpeg",
        ffprobePath: "/custom/ffprobe",
      }),
      {
        ytDlp: "/custom/yt-dlp",
        ffmpeg: "/custom/ffmpeg",
        ffprobe: "/custom/ffprobe",
      },
    );
  });
});
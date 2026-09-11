import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFile = promisify(execFileCallback);

export function resolveTargetArchitecture(
  targetArchitecture = process.env.TAURI_ENV_ARCH?.trim().toLowerCase() ||
    process.arch,
) {
  const normalizedArchitecture = targetArchitecture.trim().toLowerCase();
  switch (normalizedArchitecture) {
    case "x64":
    case "x86_64":
    case "amd64":
      return "x64";
    case "arm64":
    case "aarch64":
      return "arm64";
    default:
      throw new Error(
        `Unsupported Windows architecture "${normalizedArchitecture}". ` +
          "The desktop installer supports only x64 (x86_64) and ARM64 (aarch64). " +
          "Set TAURI_ENV_ARCH to a supported target or build for a supported Windows target.",
      );
  }
}

export function selectTargetManifest(manifest, targetArchitecture) {
  const architecture = resolveTargetArchitecture(targetArchitecture);
  const target = manifest.architectures?.[architecture];
  if (!target) {
    throw new Error(
      `No verified Windows media-tool bundle is configured for architecture "${architecture}". ` +
        "Add a pinned architecture entry to scripts/media-tools-manifest.json before building.",
    );
  }
  return {
    platform: manifest.platform,
    architecture,
    targetTriple: target.targetTriple,
    releasePolicy: manifest.releasePolicy,
    tools: target.tools,
    totalDownloadBytes: target.totalDownloadBytes,
  };
}

async function downloadVerified(tool, target) {
  const response = await fetch(tool.url, {
    headers: { "User-Agent": "archive-assistant-desktop-builder" },
  });
  if (!response.ok) {
    throw new Error(
      `Could not download ${tool.asset}: HTTP ${response.status}.`,
    );
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.byteLength !== tool.downloadBytes) {
    throw new Error(
      `Unexpected size for ${tool.asset}: expected ${tool.downloadBytes} bytes, received ${bytes.byteLength}.`,
    );
  }
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== tool.sha256) {
    throw new Error(
      `Checksum mismatch for ${tool.asset}: expected ${tool.sha256}, received ${digest}.`,
    );
  }
  await writeFile(target, bytes);
}

async function findFile(root, filename) {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isFile() && entry.name.toLowerCase() === filename.toLowerCase()) {
      return path;
    }
    if (entry.isDirectory()) {
      const match = await findFile(path, filename);
      if (match) return match;
    }
  }
  return null;
}

async function expandZip(zipPath, outputDirectory) {
  await mkdir(outputDirectory, { recursive: true });
  await execFile(
    process.env.ComSpec ?? "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "Expand-Archive -LiteralPath $env:ARCHIVE_MEDIA_ZIP -DestinationPath $env:ARCHIVE_MEDIA_OUTPUT -Force",
    ],
    {
      env: {
        ...process.env,
        ARCHIVE_MEDIA_ZIP: zipPath,
        ARCHIVE_MEDIA_OUTPUT: outputDirectory,
      },
      windowsHide: true,
    },
  );
}

async function main() {
  if (process.platform !== "win32") {
    throw new Error(
      "The Windows desktop installer must be built on Windows so its portable media tools can be staged.",
    );
  }

  const projectDir = dirname(dirname(fileURLToPath(import.meta.url)));
  const runtimeDir = join(projectDir, "src-tauri", "runtime");
  const destination = join(runtimeDir, "media-tools");
  const manifest = JSON.parse(
    await readFile(
      join(projectDir, "scripts", "media-tools-manifest.json"),
      "utf8",
    ),
  );
  const selectedManifest = selectTargetManifest(manifest);
  const temporaryDirectory = join(
    tmpdir(),
    `archive-assistant-media-tools-${process.pid}`,
  );

  try {
    await rm(destination, { recursive: true, force: true });
    await mkdir(destination, { recursive: true });
    await rm(temporaryDirectory, { recursive: true, force: true });
    await mkdir(temporaryDirectory, { recursive: true });

    const ytDlpPath = join(temporaryDirectory, "yt-dlp.exe");
    await downloadVerified(selectedManifest.tools.ytDlp, ytDlpPath);
    await copyFile(ytDlpPath, join(destination, "yt-dlp.exe"));

    const ffmpegZipPath = join(
      temporaryDirectory,
      basename(selectedManifest.tools.ffmpeg.url),
    );
    const ffmpegExtractPath = join(temporaryDirectory, "ffmpeg");
    await downloadVerified(selectedManifest.tools.ffmpeg, ffmpegZipPath);
    await expandZip(ffmpegZipPath, ffmpegExtractPath);
    for (const executable of selectedManifest.tools.ffmpeg.includes) {
      const source = await findFile(ffmpegExtractPath, executable);
      if (!source) {
        throw new Error(`The FFmpeg archive did not contain ${executable}.`);
      }
      await copyFile(source, join(destination, executable));
    }

    await copyFile(
      join(runtimeDir, "THIRD-PARTY-NOTICES.txt"),
      join(destination, "THIRD-PARTY-NOTICES.txt"),
    );
    await writeFile(
      join(destination, "manifest.json"),
      `${JSON.stringify(selectedManifest, null, 2)}\n`,
    );
    console.log(
      `Staged ${selectedManifest.architecture} yt-dlp ${selectedManifest.tools.ytDlp.version} and FFmpeg ${selectedManifest.tools.ffmpeg.version} for the Windows desktop installer.`,
    );
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  await main();
}

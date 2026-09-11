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
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFile = promisify(execFileCallback);

if (process.platform !== "win32") {
  throw new Error(
    "The Windows desktop installer must be built on Windows so its portable media tools can be staged.",
  );
}

const projectDir = dirname(dirname(fileURLToPath(import.meta.url)));
const runtimeDir = join(projectDir, "src-tauri", "runtime");
const destination = join(runtimeDir, "media-tools");
const manifest = JSON.parse(
  await readFile(join(projectDir, "scripts", "media-tools-manifest.json"), "utf8"),
);
const temporaryDirectory = join(
  tmpdir(),
  `archive-assistant-media-tools-${process.pid}`,
);

async function downloadVerified(tool, target) {
  const response = await fetch(tool.url, {
    headers: { "User-Agent": "archive-assistant-desktop-builder" },
  });
  if (!response.ok) {
    throw new Error(`Could not download ${tool.asset}: HTTP ${response.status}.`);
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

try {
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });
  await rm(temporaryDirectory, { recursive: true, force: true });
  await mkdir(temporaryDirectory, { recursive: true });

  const ytDlpPath = join(temporaryDirectory, "yt-dlp.exe");
  await downloadVerified(
    manifest.tools.ytDlp,
    ytDlpPath,
  );
  await copyFile(ytDlpPath, join(destination, "yt-dlp.exe"));

  const ffmpegZipPath = join(temporaryDirectory, basename(manifest.tools.ffmpeg.url));
  const ffmpegExtractPath = join(temporaryDirectory, "ffmpeg");
  await downloadVerified(manifest.tools.ffmpeg, ffmpegZipPath);
  await expandZip(ffmpegZipPath, ffmpegExtractPath);
  for (const executable of manifest.tools.ffmpeg.includes) {
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
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  console.log(
    `Staged yt-dlp ${manifest.tools.ytDlp.version} and FFmpeg ${manifest.tools.ffmpeg.version} for the Windows desktop installer.`,
  );
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
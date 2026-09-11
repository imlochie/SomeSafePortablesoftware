/**
 * Runs the integration smoke suite in a fully temporary environment:
 * temporary SQLite database, throwaway fixture tree, stub external binaries.
 * Nothing outside the temp directory is read or written.
 */
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const artifactDir = path.dirname(fileURLToPath(import.meta.url));
const testDir = await mkdtemp(path.join(tmpdir(), "archive-assistant-smoke-"));
const outputFile = path.join(testDir, "integration-smoke.mjs");
const databaseFile = path.join(testDir, "smoke.sqlite");

try {
  await build({
    entryPoints: [path.join(artifactDir, "integration-smoke.ts")],
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    outfile: outputFile,
    banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
    sourcemap: "inline",
    logLevel: "warning",
  });

  const exitCode = await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--test", pathToFileURL(outputFile).pathname],
      {
        stdio: "inherit",
        env: {
          ...process.env,
          AUTH_MODE: "local",
          ARCHIVE_DB_PATH: databaseFile,
          ARCHIVE_TEST_ROOT: testDir,
        },
      },
    );
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 1));
  });
  process.exitCode = exitCode;
} finally {
  await rm(testDir, { recursive: true, force: true });
}

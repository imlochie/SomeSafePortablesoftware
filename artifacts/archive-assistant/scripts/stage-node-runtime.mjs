import { copyFile, mkdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "win32") {
  throw new Error(
    "The Windows desktop installer must be built on Windows so its Node runtime can be bundled.",
  );
}

const projectDir = dirname(dirname(fileURLToPath(import.meta.url)));
const destination = join(projectDir, "src-tauri", "runtime", "node.exe");

await mkdir(dirname(destination), { recursive: true });
await copyFile(process.execPath, destination);
// The staged runtime is the one payload the desktop shell cannot launch
// without, and the bundler reports success even when a resource never makes
// it into the installer. Verify the copy landed intact so a partial or
// intercepted write fails the build here instead of shipping an installer
// with no Node runtime.
const [sourceStat, stagedStat] = await Promise.all([
  stat(process.execPath),
  stat(destination),
]);
if (stagedStat.size !== sourceStat.size) {
  throw new Error(
    `The staged Node runtime is incomplete: wrote ${stagedStat.size} of ${sourceStat.size} bytes.`,
  );
}
console.log(`Staged Node ${process.version} for the Windows desktop installer.`);

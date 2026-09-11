import { copyFile, mkdir } from "node:fs/promises";
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
console.log(`Staged Node ${process.version} for the Windows desktop installer.`);
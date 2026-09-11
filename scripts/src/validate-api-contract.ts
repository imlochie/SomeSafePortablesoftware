import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  cp,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
} from "node:fs/promises";
import { relative, resolve } from "node:path";
import { tmpdir } from "node:os";

const root = resolve(import.meta.dirname, "../..");
const routesDirectory = resolve(root, "artifacts/api-server/src/routes");
const specPath = resolve(root, "lib/api-spec/openapi.yaml");
const clientSource = resolve(root, "lib/api-client-react/src");
const zodSource = resolve(root, "lib/api-zod/src");
const checkedInClientGenerated = process.env.API_CONTRACT_CLIENT_GENERATED
  ? resolve(root, process.env.API_CONTRACT_CLIENT_GENERATED)
  : resolve(clientSource, "generated");
const checkedInZodGenerated = process.env.API_CONTRACT_ZOD_GENERATED
  ? resolve(root, process.env.API_CONTRACT_ZOD_GENERATED)
  : resolve(zodSource, "generated");
const execFileAsync = promisify(execFile);

function normalizeRuntimePath(path: string) {
  return path.replace(/:([A-Za-z0-9_]+)/g, "{$1}");
}

async function runtimeOperations() {
  const operations = new Set<string>();
  for (const entry of await readdir(routesDirectory, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".ts") || entry.name === "index.ts") continue;
    const source = await readFile(resolve(routesDirectory, entry.name), "utf8");
    const prefix = entry.name === "acquisition-webhooks.ts" ? "/acquisition-webhooks" : "";
    const routePattern = /router\.(get|post|put|patch|delete)\s*\(\s*["'`]([^"'`]+)["'`]/g;
    for (const match of source.matchAll(routePattern)) {
      operations.add(`${match[1].toUpperCase()} ${normalizeRuntimePath(`${prefix}${match[2]}`)}`);
    }
  }
  return operations;
}

function specOperations(spec: string) {
  const operations = new Set<string>();
  let currentPath: string | undefined;
  let currentMethod: string | undefined;
  for (const line of spec.split(/\r?\n/)) {
    const path = line.match(/^  (\/[^:]+(?:\{[^}]+\})?[^:]*):\s*$/);
    if (path) {
      currentPath = path[1];
      currentMethod = undefined;
      continue;
    }
    const method = line.match(/^    (get|post|put|patch|delete):\s*$/);
    if (method && currentPath) {
      currentMethod = method[1].toUpperCase();
      continue;
    }
    const operationId = line.match(/^      operationId:\s*([A-Za-z0-9_]+)\s*$/);
    if (operationId && currentPath && currentMethod) {
      operations.add(`${currentMethod} ${currentPath}`);
    }
  }
  return operations;
}

async function filesUnder(directory: string) {
  const files: string[] = [];
  async function visit(current: string) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = resolve(current, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) files.push(relative(directory, path));
    }
  }
  await visit(directory);
  return files.sort();
}

async function compareGeneratedDirectory(
  checkedInDirectory: string,
  freshDirectory: string,
  label: string,
) {
  const [checkedInFiles, freshFiles] = await Promise.all([
    filesUnder(checkedInDirectory),
    filesUnder(freshDirectory),
  ]);
  const errors: string[] = [];
  const allFiles = new Set([...checkedInFiles, ...freshFiles]);
  for (const file of [...allFiles].sort()) {
    if (!checkedInFiles.includes(file)) {
      errors.push(`${label} generated output is missing checked-in file: ${file}`);
      continue;
    }
    if (!freshFiles.includes(file)) {
      errors.push(`${label} generated output has obsolete checked-in file: ${file}`);
      continue;
    }
    const [checkedIn, fresh] = await Promise.all([
      readFile(resolve(checkedInDirectory, file)),
      readFile(resolve(freshDirectory, file)),
    ]);
    if (!checkedIn.equals(fresh)) {
      const checkedInLines = checkedIn.toString("utf8").split(/\r?\n/);
      const freshLines = fresh.toString("utf8").split(/\r?\n/);
      const changedLine = Math.max(
        0,
        checkedInLines.findIndex((line, index) => line !== freshLines[index]),
      );
      errors.push(
        `${label} generated output is stale: ${file} (first difference at line ${changedLine + 1})`,
      );
    }
  }
  return errors;
}

async function generatedDriftErrors() {
  const temporaryRoot = await mkdtemp(resolve(tmpdir(), "archive-api-contract-"));
  const temporaryClientPackage = resolve(temporaryRoot, "lib/api-client-react");
  const temporaryZodPackage = resolve(temporaryRoot, "lib/api-zod");
  const temporarySpecPackage = resolve(temporaryRoot, "lib/api-spec");
  try {
    await Promise.all([
      cp(resolve(root, "lib/api-client-react"), temporaryClientPackage, { recursive: true }),
      cp(resolve(root, "lib/api-zod"), temporaryZodPackage, { recursive: true }),
      cp(resolve(root, "lib/api-spec"), temporarySpecPackage, { recursive: true }),
      cp(resolve(root, "tsconfig.base.json"), resolve(temporaryRoot, "tsconfig.base.json")),
      cp(resolve(root, "tsconfig.json"), resolve(temporaryRoot, "tsconfig.json")),
      cp(resolve(root, "package.json"), resolve(temporaryRoot, "package.json")),
      cp(resolve(root, "pnpm-workspace.yaml"), resolve(temporaryRoot, "pnpm-workspace.yaml")),
      symlink(resolve(root, "node_modules"), resolve(temporaryRoot, "node_modules"), "dir"),
    ]);
    await execFileAsync(
      resolve(root, "lib/api-spec/node_modules/.bin/orval"),
      ["--config", resolve(temporarySpecPackage, "orval.config.ts")],
      { cwd: temporarySpecPackage },
    );
    const [clientErrors, zodErrors] = await Promise.all([
      compareGeneratedDirectory(
        checkedInClientGenerated,
        resolve(temporaryClientPackage, "src/generated"),
        "React client",
      ),
      compareGeneratedDirectory(
        checkedInZodGenerated,
        resolve(temporaryZodPackage, "src/generated"),
        "Zod",
      ),
    ]);
    return [...clientErrors, ...zodErrors];
  } finally {
    if (process.env.KEEP_API_CONTRACT_TEMP === "1") {
      console.info(`Kept temporary generated output at ${temporaryRoot}`);
    } else {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  }
}

const [runtime, spec, generationErrors] = await Promise.all([
  runtimeOperations(),
  readFile(specPath, "utf8"),
  generatedDriftErrors(),
]);
const documented = specOperations(spec);
const errors: string[] = [...generationErrors];

for (const operation of [...runtime].sort()) {
  if (!documented.has(operation)) errors.push(`Runtime route is missing from OpenAPI: ${operation}`);
}
for (const operation of [...documented].sort()) {
  if (!runtime.has(operation)) errors.push(`OpenAPI operation has no public runtime route: ${operation}`);
}

if (errors.length) {
  console.error(["API contract drift detected:", ...errors.map((error) => `- ${error}`)].join("\n"));
  process.exitCode = 1;
} else {
  console.info(`API contracts are aligned across ${runtime.size} public operations.`);
}
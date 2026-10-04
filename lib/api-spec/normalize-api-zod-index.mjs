#!/usr/bin/env node
// Normalizes lib/api-zod/src/index.ts after Orval codegen.
//
// Orval's zod client emits operation-level zod schemas (including request
// bodies) in generated/api.ts, and the matching TypeScript types in
// generated/types/. When a name exists in both places (for example
// `AskArenaCanonicalBody` as a zod const and as a type), the generated
// two-line star-export barrel makes `tsc` fail with TS2308 ambiguities:
//
//   export * from './generated/api';
//   export * from './generated/types';
//
// Explicit re-exports take precedence over `export *`, so this script appends
// one explicit export per colliding name, sourced from generated/api.ts where
// the zod schema (value + inferred type) is the authoritative binding. The
// output is deterministic and idempotent, and it keeps every generated name
// reachable from the package root.
//
// Run automatically by `pnpm --filter @workspace/api-spec run codegen`.

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const specDir = fileURLToPath(new URL(".", import.meta.url));
const apiZodSrc = join(specDir, "..", "api-zod", "src");
const apiFile = join(apiZodSrc, "generated", "api.ts");
const typesDir = join(apiZodSrc, "generated", "types");

const exportedNames = (source) => {
  const names = new Set();
  for (const match of source.matchAll(/^export (?:const|type|interface) (\w+)/gm)) {
    names.add(match[1]);
  }
  return names;
};

const apiNames = exportedNames(readFileSync(apiFile, "utf8"));

const typeNames = new Set();
for (const entry of readdirSync(typesDir, { withFileTypes: true })) {
  if (!entry.isFile() || !entry.name.endsWith(".ts") || entry.name === "index.ts") continue;
  for (const name of exportedNames(readFileSync(join(typesDir, entry.name), "utf8"))) {
    typeNames.add(name);
  }
}

const collisions = [...apiNames]
  .filter((name) => typeNames.has(name))
  .sort((a, b) => a.localeCompare(b, "en"));

const lines = [
  "export * from './generated/api';",
  "export * from './generated/types';",
];
if (collisions.length > 0) {
  lines.push("export {");
  for (const name of collisions) lines.push(`  ${name},`);
  lines.push("} from './generated/api';");
}
lines.push("");

writeFileSync(join(apiZodSrc, "index.ts"), lines.join("\n"), "utf8");

const summary =
  collisions.length === 0
    ? "no ambiguous generated names"
    : `explicitly re-exported ${collisions.length} ambiguous name(s) from generated/api: ${collisions.join(", ")}`;
console.log(`Normalized lib/api-zod/src/index.ts (${summary}).`);

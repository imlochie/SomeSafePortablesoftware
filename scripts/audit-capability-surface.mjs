#!/usr/bin/env node
/**
 * Capability surface audit.
 *
 * Finds public API operations that no UI code can reach. The premise is that a
 * capability reachable only through the API or an AI tool is unfinished product
 * surface, not a finished backend feature.
 *
 * Evidence, not opinion: every operationId in the OpenAPI spec is turned into
 * its generated hook name, and we check whether that name appears anywhere in
 * the client source. A hook that appears nowhere has no door into it.
 *
 *   node scripts/audit-capability-surface.mjs
 *   node scripts/audit-capability-surface.mjs --json
 *
 * Exits non-zero only with --strict, so it can become a CI gate later without
 * breaking the build today.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SPEC = join(root, "lib/api-spec/openapi.yaml");
const UI_SRC = join(root, "artifacts/archive-assistant/src");

/**
 * Operations that are legitimately backend-only, with the reason. Anything not
 * listed here is expected to have a human entry point.
 */
const INTENTIONALLY_BACKEND_ONLY = new Map([
  ["receiveAcquisitionWebhook", "Provider callback, not a user action."],
  ["getArchiveOperation", "Legacy compatibility adapter over the action engine."],
  ["inspectLocalMedia", "Internal probe used by the scanner."],
  ["streamDownloadEvents", "SSE transport; the UI currently polls instead."],
]);

function collectOperations(spec) {
  const operations = [];
  let path = null;
  let method = null;
  for (const line of spec.split("\n")) {
    const pathMatch = /^ {2}(\/\S*):\s*$/.exec(line);
    if (pathMatch) {
      path = pathMatch[1];
      continue;
    }
    const methodMatch = /^ {4}(get|post|patch|put|delete):\s*$/.exec(line);
    if (methodMatch && path) {
      method = methodMatch[1].toUpperCase();
      continue;
    }
    const idMatch = /^ {6}operationId:\s*(\S+)/.exec(line);
    if (idMatch && path && method) {
      operations.push({ method, path, operationId: idMatch[1] });
      method = null;
    }
  }
  return operations;
}

function readSources(dir) {
  let text = "";
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      text += readSources(full);
    } else if (/\.(ts|tsx)$/.test(entry)) {
      text += readFileSync(full, "utf8");
    }
  }
  return text;
}

const operations = collectOperations(readFileSync(SPEC, "utf8"));
const ui = readSources(UI_SRC);

const unreachable = operations.filter(({ operationId }) => {
  const hook = `use${operationId[0].toUpperCase()}${operationId.slice(1)}`;
  return !ui.includes(hook);
});
const unexplained = unreachable.filter((op) => !INTENTIONALLY_BACKEND_ONLY.has(op.operationId));

if (process.argv.includes("--json")) {
  console.log(JSON.stringify({ total: operations.length, unreachable, unexplained }, null, 2));
} else {
  console.log(`Public API operations:            ${operations.length}`);
  console.log(`No UI hook usage:                 ${unreachable.length}`);
  console.log(`Backend-only by design:           ${unreachable.length - unexplained.length}`);
  console.log(`Unexplained (missing a door):     ${unexplained.length}\n`);

  const byPrefix = new Map();
  for (const op of unexplained) {
    const group = op.path.split("/")[1] ?? "other";
    byPrefix.set(group, [...(byPrefix.get(group) ?? []), op]);
  }
  for (const [group, ops] of [...byPrefix].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`  ${group} (${ops.length})`);
    for (const op of ops) console.log(`    ${op.method.padEnd(6)} ${op.path.padEnd(48)} ${op.operationId}`);
  }
  console.log("\nSee docs/capability-surface-audit.md for the graded matrix.");
}

if (process.argv.includes("--strict") && unexplained.length > 0) process.exit(1);

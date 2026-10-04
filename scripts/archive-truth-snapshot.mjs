/**
 * Archive truth snapshot.
 *
 * Reports what the archive actually looks like right now, by calling the same
 * services the application calls. It does not reimplement their logic in SQL,
 * because a second implementation would drift and produce numbers the product
 * disagrees with.
 *
 * Strictly read-only: it opens the database, runs reporting services, and
 * writes a JSON file outside the repository tree. It never mutates archive
 * state and never touches media.
 *
 * Usage, from the repository root on the machine holding the archive:
 *
 *   node scripts/archive-truth-snapshot.mjs
 *   node scripts/archive-truth-snapshot.mjs --out C:\snapshots\after.json
 *   node scripts/archive-truth-snapshot.mjs --compare C:\snapshots\before.json
 *
 * The API server bundle must be built first, since this imports its compiled
 * services:
 *
 *   pnpm --filter @workspace/api-server run build
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

const ownerId = argValue("--owner") ?? process.env.ARCHIVE_OWNER_ID ?? "__local__";
const comparePath = argValue("--compare");
const outPath = argValue("--out");

/**
 * The services resolve their database through runtimeConfig, which reads
 * ARCHIVE_DB_PATH and otherwise falls back to ./data relative to the working
 * directory. Resolve it here too so the snapshot can state which file it read
 * and refuse to report zeroes from a database that does not exist.
 */
function resolveDatabasePath() {
  return resolve(
    process.env.ARCHIVE_DB_PATH ?? join(process.cwd(), "data", "archive-assistant.sqlite"),
  );
}

function fail(message, hint) {
  console.error(`\n  Snapshot failed: ${message}`);
  if (hint) console.error(`  ${hint}\n`);
  process.exit(1);
}

/**
 * The API server builds to a single bundled file, so its services cannot be
 * imported individually from dist. They are bundled on demand from source
 * instead, the same way the test runner loads them. This keeps the snapshot
 * reporting exactly what the application reports, with no second
 * implementation to drift.
 */
async function loadServices() {
  const sourceDir = resolve("artifacts/api-server/src/services");
  const entryPoints = [
    join(sourceDir, "reconciliation.ts"),
    join(sourceDir, "identity-audit.ts"),
    join(sourceDir, "naming-intelligence.ts"),
  ];
  for (const entry of entryPoints) {
    if (!existsSync(entry)) fail(`expected service source at ${entry}`);
  }
  // esbuild is a dependency of the api-server workspace, not of scripts/, and
  // pnpm does not hoist it to the root. Resolve it from the workspace that
  // actually declares it so this runs from any working directory.
  let build;
  try {
    const requireFromApiServer = createRequire(
      pathToFileURL(resolve("artifacts/api-server/package.json")).href,
    );
    ({ build } = await import(pathToFileURL(requireFromApiServer.resolve("esbuild")).href));
  } catch {
    fail(
      "esbuild could not be resolved from the api-server workspace.",
      "Run: pnpm install --frozen-lockfile",
    );
  }

  const outDir = await mkdtemp(join(tmpdir(), "archive-snapshot-"));
  await build({
    entryPoints,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    outdir: outDir,
    outExtension: { ".js": ".mjs" },
    logLevel: "warning",
    // node:sqlite and the rest of the Node built-ins must stay external.
    packages: "external",
  });
  const load = (name) => import(pathToFileURL(join(outDir, name)).href);
  const [reconciliation, identityAudit, naming] = await Promise.all([
    load("reconciliation.mjs"),
    load("identity-audit.mjs"),
    load("naming-intelligence.mjs"),
  ]);
  return { reconciliation, identityAudit, naming, cleanup: () => rm(outDir, { recursive: true, force: true }) };
}

function pct(part, whole) {
  if (!whole) return "n/a";
  return `${((part / whole) * 100).toFixed(1)}%`;
}

function delta(after, before) {
  if (typeof before !== "number" || typeof after !== "number") return "";
  const difference = after - before;
  if (difference === 0) return "  (unchanged)";
  return `  (${difference > 0 ? "+" : ""}${difference.toLocaleString()})`;
}

function table(rows, previous = {}) {
  const width = Math.max(...rows.map(([label]) => label.length));
  for (const [label, value, note] of rows) {
    const rendered = typeof value === "number" ? value.toLocaleString() : String(value);
    const change = delta(typeof value === "number" ? value : NaN, previous[label]);
    console.log(
      `  ${label.padEnd(width)}  ${rendered.padStart(9)}${change}${note ? `   ${note}` : ""}`,
    );
  }
}

async function main() {
  const started = Date.now();
  const databasePath = resolveDatabasePath();
  if (!existsSync(databasePath)) {
    fail(
      `no archive database at ${databasePath}`,
      "Set ARCHIVE_DB_PATH to the database the desktop application uses, or run\n"
        + "  this from the directory containing data/archive-assistant.sqlite.",
    );
  }

  console.log("\n  ARCHIVE TRUTH SNAPSHOT");
  console.log(`  owner:    ${ownerId}`);
  console.log(`  database: ${databasePath}`);
  console.log(`  taken:    ${new Date().toISOString()}\n`);

  const { reconciliation, identityAudit, naming, cleanup } = await loadServices();

  // pageSize 1 everywhere: only the summaries are wanted, and paging a large
  // archive into memory to count it would be wasteful.
  const report = await reconciliation.readReconciliationReport(ownerId, 1, 1);
  const audit = await identityAudit.readIdentityAudit(ownerId, { page: 1, pageSize: 1 });
  const proposals = await naming.readNamingProposals(ownerId, { page: 1, pageSize: 1 });

  const summary = report.summary;
  const snapshot = {
    takenAt: new Date().toISOString(),
    ownerId,
    databasePath,
    inventory: {
      localRecords: summary.localCount,
      plexRecords: summary.plexCount,
    },
    reconciliation: {
      matched: summary.matchedCount,
      localOnly: summary.localOnlyCount,
      plexOnly: summary.plexOnlyCount,
      uncertain: summary.uncertainCount,
      duplicates: summary.duplicateCount,
      qualityConflicts: summary.qualityConflictCount,
    },
    identity: {
      totalCandidates: audit.summary.totalCandidates,
      byConfidence: audit.summary.byConfidence,
      byAuditType: audit.summary.byAuditType,
    },
    naming: {
      total: proposals.summary.total,
      actionable: proposals.summary.actionable,
      uncertain: proposals.summary.uncertain,
      collisions: proposals.summary.collisions,
      highConfidence: proposals.summary.highConfidence,
      mediumConfidence: proposals.summary.mediumConfidence,
      lowConfidence: proposals.summary.lowConfidence,
    },
  };

  let previous = null;
  if (comparePath) {
    const resolved = resolve(comparePath);
    if (!existsSync(resolved)) fail(`comparison snapshot not found at ${resolved}`);
    previous = JSON.parse(readFileSync(resolved, "utf8"));
    console.log(`  comparing against ${previous.takenAt}\n`);
  }

  const flatten = (value) => (value
    ? {
      "local records": value.inventory.localRecords,
      "Plex records": value.inventory.plexRecords,
      matched: value.reconciliation.matched,
      "local only": value.reconciliation.localOnly,
      "Plex only": value.reconciliation.plexOnly,
      uncertain: value.reconciliation.uncertain,
      duplicates: value.reconciliation.duplicates,
      "quality conflicts": value.reconciliation.qualityConflicts,
      "identity candidates": value.identity.totalCandidates,
      "naming proposals": value.naming.total,
      actionable: value.naming.actionable,
      "naming collisions": value.naming.collisions,
    }
    : {});
  const before = flatten(previous);

  console.log("  INVENTORY");
  table([
    ["local records", snapshot.inventory.localRecords],
    ["Plex records", snapshot.inventory.plexRecords],
  ], before);

  console.log("\n  RECONCILIATION");
  table([
    ["matched", snapshot.reconciliation.matched, pct(snapshot.reconciliation.matched, summary.localCount)],
    ["local only", snapshot.reconciliation.localOnly, pct(snapshot.reconciliation.localOnly, summary.localCount)],
    ["Plex only", snapshot.reconciliation.plexOnly, pct(snapshot.reconciliation.plexOnly, summary.plexCount)],
    ["uncertain", snapshot.reconciliation.uncertain],
    ["duplicates", snapshot.reconciliation.duplicates],
    ["quality conflicts", snapshot.reconciliation.qualityConflicts],
  ], before);

  console.log("\n  IDENTITY AUDIT");
  table([["identity candidates", snapshot.identity.totalCandidates]], before);
  for (const [key, value] of Object.entries(snapshot.identity.byConfidence)) {
    console.log(`    confidence ${key.padEnd(12)} ${String(value).padStart(9)}`);
  }
  for (const [key, value] of Object.entries(snapshot.identity.byAuditType)) {
    console.log(`    ${key.padEnd(23)} ${String(value).padStart(9)}`);
  }

  console.log("\n  NAMING PROPOSALS");
  table([
    ["naming proposals", snapshot.naming.total],
    ["actionable", snapshot.naming.actionable],
    ["uncertain", snapshot.naming.uncertain],
    ["naming collisions", snapshot.naming.collisions],
  ], before);
  console.log(
    `    confidence high/medium/low  ${snapshot.naming.highConfidence} / `
      + `${snapshot.naming.mediumConfidence} / ${snapshot.naming.lowConfidence}`,
  );

  const destination = resolve(
    outPath ?? `archive-snapshot-${snapshot.takenAt.replace(/[:.]/g, "-")}.json`,
  );
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, `${JSON.stringify(snapshot, null, 2)}\n`);

  console.log(`\n  written to ${destination}`);
  console.log(`  completed in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  console.log("  read-only: no archive state was modified.\n");
  await cleanup();
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});

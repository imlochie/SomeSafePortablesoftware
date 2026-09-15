#!/usr/bin/env node
// Fail-fast release gate.
//
// Runs the checks that must hold before main is published, in increasing order
// of cost so the cheapest signal fails first. Any failing step aborts the run
// and returns a non-zero exit code.

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** @type {{ name: string, command: string, args: string[] }[]} */
const steps = [
  {
    name: "API contract alignment",
    command: "pnpm",
    args: ["run", "validate:api-contract"],
  },
  {
    name: "Workspace typecheck",
    command: "pnpm",
    args: ["run", "typecheck"],
  },
  {
    name: "API server tests",
    command: "pnpm",
    args: ["--filter", "@workspace/api-server", "run", "test"],
  },
  {
    name: "Archive Assistant tests",
    command: "pnpm",
    args: ["--filter", "@workspace/archive-assistant", "run", "test"],
  },
];

function run(step) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(step.command, step.args, {
      cwd: root,
      stdio: "inherit",
      shell: process.platform === "win32",
    });
    child.once("error", reject);
    child.once("close", (code) => resolvePromise(code ?? 1));
  });
}

const started = Date.now();
for (const [index, step] of steps.entries()) {
  const label = `[${index + 1}/${steps.length}] ${step.name}`;
  console.log(`\n=== ${label} ===`);
  const code = await run(step);
  if (code !== 0) {
    console.error(`\nRelease check failed at: ${step.name}`);
    process.exit(code);
  }
}

const seconds = ((Date.now() - started) / 1000).toFixed(1);
console.log(`\nAll ${steps.length} release checks passed in ${seconds}s.`);

import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { inspectBatchOperation } from "../src/services/archive-operations";

async function state(state: "planned" | "temporary" | "completed" | "reverted", files: string[]) {
  const root = await mkdtemp(join(tmpdir(), "archive-assistant-recovery-"));
  await mkdir(join(root, "tmp"));
  for (const file of files) await writeFile(join(root, file), file);
  const mapping = { id: state, originalPath: join(root, "original"), temporaryPath: join(root, "tmp", "step"), finalPath: join(root, "final"), state };
  const result = await inspectBatchOperation({ batch: [mapping] } as never);
  await rm(root, { recursive: true, force: true });
  return result[0].classification;
}

test("recovery inspection classifies not-started, temporary, final, and reverted states", async () => {
  assert.equal(await state("planned", ["original"]), "CONFIRMED_NOT_STARTED");
  assert.equal(await state("temporary", ["tmp/step"]), "CONFIRMED_TEMPORARY");
  assert.equal(await state("completed", ["final"]), "CONFIRMED_FINAL");
  assert.equal(await state("reverted", ["original"]), "CONFIRMED_REVERTED");
});

test("recovery inspection classifies conflicts and unknown states conservatively", async () => {
  assert.equal(await state("completed", ["original", "final"]), "CONFLICT");
  assert.equal(await state("completed", []), "UNKNOWN");
});

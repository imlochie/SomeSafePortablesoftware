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

test("recovery inspection keeps partial and missing temporary states unresolved", async () => {
  const root = await mkdtemp(join(tmpdir(), "archive-assistant-recovery-partial-"));
  await mkdir(join(root, "tmp"));
  await writeFile(join(root, "final-a"), "A");
  const result = await inspectBatchOperation({ batch: [
    { id: "a", originalPath: join(root, "original-a"), temporaryPath: join(root, "tmp", "step-a"), finalPath: join(root, "final-a"), state: "completed" },
    { id: "b", originalPath: join(root, "original-b"), temporaryPath: join(root, "tmp", "missing-step-b"), finalPath: join(root, "final-b"), state: "temporary" },
  ] } as never);
  assert.equal(result[0].classification, "CONFIRMED_FINAL");
  assert.equal(result[1].classification, "UNKNOWN");
  await rm(root, { recursive: true, force: true });
});

test("recovery inspection does not infer completion when a cycle still has both paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "archive-assistant-recovery-cycle-partial-"));
  await writeFile(join(root, "A"), "A-content");
  await writeFile(join(root, "B"), "B-content");
  const result = await inspectBatchOperation({ batch: [
    { id: "a", originalPath: join(root, "A"), temporaryPath: join(root, "tmp-a"), finalPath: join(root, "B"), state: "planned" },
  ] } as never);
  assert.equal(result[0].classification, "CONFLICT");
  await rm(root, { recursive: true, force: true });
});

test("recovery inspection understands a completed two-file swap", async () => {
  const root = await mkdtemp(join(tmpdir(), "archive-assistant-recovery-cycle-"));
  await writeFile(join(root, "A"), "B-content");
  await writeFile(join(root, "B"), "A-content");
  const result = await inspectBatchOperation({ batch: [
    { id: "a", originalPath: join(root, "A"), temporaryPath: join(root, "tmp-a"), finalPath: join(root, "B"), state: "completed" },
    { id: "b", originalPath: join(root, "B"), temporaryPath: join(root, "tmp-b"), finalPath: join(root, "A"), state: "completed" },
  ] } as never);
  assert.deepEqual(result.map((item) => item.classification), ["CONFIRMED_FINAL", "CONFIRMED_FINAL"]);
  await rm(root, { recursive: true, force: true });
});

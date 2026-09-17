import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { executeBatchFiles, inspectBatchOperation, preflightBatchFiles, revertBatchFiles, type BatchFileState } from "../src/services/archive-operations";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "archive-assistant-batch-"));
  await mkdir(join(root, "tmp"));
  await writeFile(join(root, "A"), "A");
  await writeFile(join(root, "B"), "B");
  await writeFile(join(root, "C"), "C");
  const mappings: BatchFileState[] = [
    { id: "a", originalPath: join(root, "A"), temporaryPath: join(root, "tmp", "a"), finalPath: join(root, "B"), state: "planned" },
    { id: "b", originalPath: join(root, "B"), temporaryPath: join(root, "tmp", "b"), finalPath: join(root, "C"), state: "planned" },
    { id: "c", originalPath: join(root, "C"), temporaryPath: join(root, "tmp", "c"), finalPath: join(root, "A"), state: "planned" },
  ];
  return { root, mappings };
}

test("batch preflight blocks before mutation when a source is missing", async () => {
  const { root, mappings } = await fixture();
  const missing = [{ ...mappings[0], originalPath: join(root, "missing") }, ...mappings.slice(1)];
  const result = await preflightBatchFiles(missing);
  assert.equal(result.ok, false);
  assert.deepEqual(await readdir(root), ["A", "B", "C", "tmp"]);
});

test("batch execution performs a three-file cycle and exact revert", async () => {
  const { root, mappings } = await fixture();
  const check = await preflightBatchFiles(mappings);
  assert.equal(check.ok, true, check.error);
  const result = await executeBatchFiles(mappings);
  if (result.state !== "completed") assert.fail(JSON.stringify(result));
  assert.equal(await readFile(join(root, "A"), "utf8"), "C");
  assert.equal(await readFile(join(root, "B"), "utf8"), "A");
  assert.equal(await readFile(join(root, "C"), "utf8"), "B");
  const reverted = await revertBatchFiles(mappings);
  assert.equal(reverted.state, "completed");
  assert.equal(await readFile(join(root, "A"), "utf8"), "A");
  assert.equal(await readFile(join(root, "B"), "utf8"), "B");
  assert.equal(await readFile(join(root, "C"), "utf8"), "C");
});

test("batch preflight rejects an unrelated destination occupant", async () => {
  const { root, mappings } = await fixture();
  await writeFile(join(root, "D"), "unrelated");
  const result = await preflightBatchFiles([{ ...mappings[0], finalPath: join(root, "D") }]);
  assert.equal(result.ok, false);
  assert.equal(await readFile(join(root, "A"), "utf8"), "A");
  assert.equal(await readFile(join(root, "D"), "utf8"), "unrelated");
});

test("batch preflight rejects oversized batches before touching the filesystem", async () => {
  const result = await preflightBatchFiles(new Array(5001).fill({ id: "x", originalPath: "/source", temporaryPath: "/temporary", finalPath: "/destination", state: "planned" }));
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /limited to 5000/);
});

test("batch preflight rejects duplicate sources and temporary-path conflicts", async () => {
  const { root, mappings } = await fixture();
  const duplicateSource = await preflightBatchFiles([mappings[0], { ...mappings[1], originalPath: mappings[0].originalPath }]);
  assert.equal(duplicateSource.ok, false);
  assert.match(duplicateSource.error ?? "", /Duplicate source/);
  const temporarySourceConflict = await preflightBatchFiles([{ ...mappings[0], temporaryPath: mappings[1].originalPath }, mappings[1]]);
  assert.equal(temporarySourceConflict.ok, false);
  assert.match(temporarySourceConflict.error ?? "", /Temporary path conflicts/);
  const temporaryDestinationConflict = await preflightBatchFiles([{ ...mappings[0], finalPath: mappings[1].temporaryPath }, mappings[1]]);
  assert.equal(temporaryDestinationConflict.ok, false);
  assert.match(temporaryDestinationConflict.error ?? "", /Temporary path conflicts with a destination/);
});

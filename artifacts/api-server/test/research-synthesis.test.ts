import assert from "node:assert/strict";
import test from "node:test";

test("multi-source synthesis distinguishes comparable agreement from conflict", async () => {
  const { reconcileAudienceRatings } = await import("../src/services/research-synthesis");
  const aligned = reconcileAudienceRatings(8.5, 8.1);
  assert.deepEqual(aligned.conflicts, []);
  assert.equal(aligned.supports.length, 1);
  const conflicting = reconcileAudienceRatings(8.5, 6.1);
  assert.equal(conflicting.conflicts.length, 1);
  assert.deepEqual(conflicting.supports, []);
});

test("missing comparable metrics remain unknown", async () => {
  const { reconcileAudienceRatings } = await import("../src/services/research-synthesis");
  const result = reconcileAudienceRatings(8.5, null);
  assert.deepEqual(result.conflicts, []);
  assert.deepEqual(result.supports, []);
  assert.equal(result.unknown.length, 1);
});

test("empty v3 candidate set produces a bounded synthesis without external calls", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; return new Response("unexpected", { status: 500 }); };
  try {
    const { synthesizeViewingResearch } = await import("../src/services/research-synthesis");
    const result = await synthesizeViewingResearch("__synthesis_empty__");
    assert.equal(result.items.length, 0);
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

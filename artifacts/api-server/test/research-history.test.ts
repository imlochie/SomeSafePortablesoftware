import assert from "node:assert/strict";
import test from "node:test";

test("history research is bounded and explicit when there is no watched seed", async () => {
  const { researchFromViewingHistory } = await import("../src/services/research-history");
  const result = await researchFromViewingHistory("__research_empty__");
  assert.equal(result.status, "limited");
  assert.equal(result.items.length, 0);
  assert.deepEqual(result.bounds, { maxWatchedSeeds: 20, maxCandidates: 100 });
  assert.equal(result.identityUncertain, 0);
});

test("history research does not call the provider when there are no watched seeds", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; return new Response("unexpected", { status: 500 }); };
  try {
    const { researchFromViewingHistory } = await import("../src/services/research-history");
    await researchFromViewingHistory("__research_empty_again__");
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

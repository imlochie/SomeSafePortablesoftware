import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { GetSystemDependenciesResponse } from "@workspace/api-zod";
import { readSettings } from "../src/lib/archive-db";
import {
  dependencyDefinitions,
  detectDependency,
} from "../src/services/system-dependencies";

describe("system dependency status", { concurrency: false }, () => {
  test("always returns schema-valid capability metadata", async () => {
    const dependencies = GetSystemDependenciesResponse.parse(
      dependencyDefinitions.map((dependency) =>
        detectDependency(dependency, readSettings()),
      ),
    );
    assert.equal(dependencies.length, 5);

    for (const dependency of dependencies) {
      assert.ok(Array.isArray(dependency.capabilities));
      if (dependency.name !== "FFmpeg") {
        assert.deepEqual(dependency.capabilities, []);
      }
    }
  });
});
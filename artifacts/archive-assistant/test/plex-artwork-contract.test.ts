import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const appSource = await readFile(join(dirname(fileURLToPath(import.meta.url)), "..", "src", "App.tsx"), "utf8");

describe("Plex artwork presentation contract", () => {
  test("uses lazy loading for inventory artwork", () => {
    expect(appSource).toContain('loading="lazy"');
    expect(appSource).toContain("/api/plex/artwork/");
  });

  test("fails closed to the existing neutral placeholder when artwork cannot load", () => {
    expect(appSource).toContain("onError={(event) => { event.currentTarget.style.display = 'none'; }}");
    expect(appSource).toContain("item.itemType === 'movie' ? <PlaySquare");
    expect(appSource).toContain(": <FolderOpen");
  });
});

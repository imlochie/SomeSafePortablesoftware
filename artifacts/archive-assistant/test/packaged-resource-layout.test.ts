import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The desktop shell resolves the bundled API and Node runtime from paths that
 * Tauri decides at package time. Those paths live in `tauri.conf.json` while
 * the lookup lives in `src-tauri/src/main.rs`, so nothing in the compiler
 * catches the two drifting apart -- and the symptom only appears in an
 * installed build, never in `pnpm dev`.
 *
 * These tests encode the packaging contract itself so a config edit that moves
 * a resource fails here instead of in a shipped installer.
 */

const srcTauriDir = path.resolve(import.meta.dirname, '..', 'src-tauri');
const tauriConfig = JSON.parse(
  readFileSync(path.join(srcTauriDir, 'tauri.conf.json'), 'utf8'),
) as { bundle?: { resources?: string[] | Record<string, string> } };
const mainRs = readFileSync(path.join(srcTauriDir, 'src', 'main.rs'), 'utf8');

/**
 * Mirrors Tauri v2's resource remapping: a path that escapes `src-tauri` has
 * each leading `..` component rewritten to `_up_`, and an absolute root becomes
 * `_root_`. `./foo/bar` keeps its relative structure.
 * https://v2.tauri.app/develop/resources/
 */
function packagedResourcePath(resource: string): string {
  return resource
    .split('/')
    .filter((segment) => segment !== '' && segment !== '.')
    .map((segment) => (segment === '..' ? '_up_' : segment))
    .join('/');
}

/** Extracts the resource-relative candidate paths declared in main.rs. */
function declaredApiEntryCandidates(): string[] {
  const block = mainRs.match(
    /const API_ENTRY_RESOURCE_CANDIDATES:[^=]+=\s*\[(.*?)\];/s,
  );
  expect(block, 'API_ENTRY_RESOURCE_CANDIDATES must exist in main.rs').not.toBeNull();

  return Array.from(block![1].matchAll(/&\[([^\]]*)\]/g)).map((entry) =>
    Array.from(entry[1].matchAll(/"([^"]+)"/g))
      .map((segment) => segment[1])
      .join('/'),
  );
}

describe('packaged resource layout', () => {
  const resources = tauriConfig.bundle?.resources;

  it('declares the API bundle and runtime as bundled resources', () => {
    expect(Array.isArray(resources)).toBe(true);
    expect(resources).toContain('runtime');
    expect(
      (resources as string[]).some((resource) => resource.endsWith('api-server/dist')),
    ).toBe(true);
  });

  it('probes the exact location Tauri unpacks the API bundle to', () => {
    const apiResource = (resources as string[]).find((resource) =>
      resource.endsWith('api-server/dist'),
    )!;
    const expected = `${packagedResourcePath(apiResource)}/index.mjs`;

    // "../../api-server/dist" must be probed as
    // "_up_/_up_/api-server/dist/index.mjs", not "api-server/dist/index.mjs".
    expect(expected).toBe('_up_/_up_/api-server/dist/index.mjs');
    expect(declaredApiEntryCandidates()).toContain(expected);
  });

  it('resolves the API entry from a Result so a miss reports every probed path', () => {
    expect(mainRs).toMatch(/fn api_entry_path\(app: &AppHandle\) -> Result<PathBuf, String>/);
    // The old code returned a bare PathBuf and reported only the last guess.
    expect(mainRs).not.toMatch(/fn api_entry_path\(app: &AppHandle\) -> PathBuf/);
  });

  it('reads the Node runtime from the plain "runtime" resource directory', () => {
    // "runtime" has no ".." to remap, so it stays at $RESOURCE/runtime.
    expect(packagedResourcePath('runtime')).toBe('runtime');
    expect(mainRs).toMatch(/join\("runtime"\)\.join\(BUNDLED_NODE_FILE_NAME\)/);
    expect(mainRs).toMatch(/join\("runtime"\)\.join\("media-tools"\)/);
  });

  it('never silently falls back to a system Node in a release build', () => {
    // The whole point of bundling Node is that an install works on a machine
    // with no Node at all. A bare "node.exe" fallback would mask a broken
    // install as a mysterious runtime error -- or run on an unverified Node.
    expect(mainRs).toMatch(/if !cfg!\(debug_assertions\)/);
    expect(mainRs).toMatch(/The bundled Node runtime is missing from this installation/);
    expect(mainRs).toMatch(/fn node_command\(app: &AppHandle\) -> Result<PathBuf, String>/);
  });

  it('still honours ARCHIVE_NODE_PATH as an escape hatch', () => {
    expect(mainRs).toMatch(/env::var_os\("ARCHIVE_NODE_PATH"\)/);
  });
});

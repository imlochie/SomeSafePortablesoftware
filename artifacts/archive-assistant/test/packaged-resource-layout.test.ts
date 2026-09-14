import { readFileSync } from 'node:fs';
import path from 'node:path';
import { win32 } from 'node:path';
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
const windowsWorkflowPath = path.resolve(
  import.meta.dirname,
  '..',
  '..',
  '..',
  '.github',
  'workflows',
  'windows-installer.yml',
);
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

/**
 * Port of `strip_verbatim_prefix` from main.rs. Rust's `Path::canonicalize`
 * returns `\\?\C:\...` on Windows.
 *
 * A hand-written mirror of the Rust would happily keep passing while the real
 * implementation was broken, so `pinsRustImplementation` below asserts that the
 * shipped Rust still has the shape this port assumes. The two must fail
 * together.
 */
function stripVerbatimPrefix(value: string): string {
  const remainder = value.startsWith('\\\\?\\') ? value.slice(4) : null;
  if (remainder === null) return value;

  const isDrivePath =
    /^[A-Za-z]$/.test(remainder.charAt(0)) &&
    remainder.charAt(1) === ':' &&
    (remainder.length === 2 || remainder.charAt(2) === '\\');

  if (!isDrivePath) return value;
  // `C:` alone is drive-relative; the root separator must be preserved.
  return remainder.length === 2 ? `${remainder}\\` : remainder;
}

/**
 * Node's real `splitRoot` from lib/fs.js, used by `realpathSync` -- which is
 * what `resolveMainPath` calls on the main module. Whatever this returns is the
 * first path Node stats, so it is the precise predictor of `lstat 'C:'`.
 */
const splitRootRe = /^(?:[a-zA-Z]:|[\\/]{2}[^\\/]+[\\/][^\\/]+)?[\\/]*/;
const nodeLstatTarget = (value: string): string => splitRootRe.exec(value)![0];

/** The structural facts the port above depends on, as written in main.rs. */
function pinsRustImplementation(): void {
  const rust = mainRs.match(/fn strip_verbatim_prefix[\s\S]*?\n}/)![0];

  // Prefix is the four characters \\?\ and is matched exactly, with
  // non-matches returned unchanged.
  expect(rust).toContain(String.raw`const VERBATIM_PREFIX: &str = r"\\?\";`);
  expect(rust).toMatch(/strip_prefix\(VERBATIM_PREFIX\) else \{\s*return path;/);
  // Drive-letter shape: alphabetic, ':', then end-of-string or a separator.
  expect(rust).toContain('is_ascii_alphabetic()');
  expect(rust).toContain(String.raw`Some(':')`);
  expect(rust).toContain(String.raw`None | Some('\\')`);
  // Only the drive form is rewritten; everything else is returned as-is.
  expect(rust).toMatch(/if !is_drive_path \{\s*return path;\s*\}/);
  // A bare `X:` gains the root separator instead of staying drive-relative.
  expect(rust).toContain('if remainder.len() == 2 {');
  expect(rust).toContain(String.raw`return PathBuf::from(format!("{remainder}\\"));`);
  expect(rust).toMatch(/PathBuf::from\(remainder\)\s*\}/);
}

describe('packaged resource layout', () => {
  const resources = tauriConfig.bundle?.resources;

  /**
   * Tauri's documented source-path syntax gives a bare directory name no
   * defined meaning: only `dir/` (recursive), `dir/*` (non-recursive) and
   * explicit globs are specified. A bare `runtime` entry produced an installer
   * whose `runtime/` directory never shipped -- the app started, found the API
   * bundle, then failed on the missing Node runtime. Every source entry must
   * therefore carry a trailing slash or a glob.
   * https://v2.tauri.app/develop/resources/
   */
  it('uses the map form so each resource has an explicit destination', () => {
    expect(Array.isArray(resources)).toBe(false);
    expect(typeof resources).toBe('object');
  });

  it.each([
    ['the API bundle', '../../api-server/dist/', 'api-server/dist/'],
    ['the bundled runtime', 'runtime/', 'runtime/'],
  ])('ships %s at an explicit destination', (_label, source, destination) => {
    const map = resources as Record<string, string>;
    expect(Object.keys(map)).toContain(source);
    expect(map[source]).toBe(destination);
  });

  it.each(Object.keys((tauriConfig.bundle?.resources ?? {}) as Record<string, string>))(
    'declares source %s with recursive directory syntax',
    (source) => {
      // A bare directory name is not documented syntax and silently shipped
      // nothing. Require a trailing slash or an explicit glob.
      expect(source.endsWith('/') || source.includes('*')).toBe(true);
    },
  );

  it('probes the exact location Tauri unpacks the API bundle to', () => {
    const map = resources as Record<string, string>;
    const destination = map['../../api-server/dist/'];
    const expected = `${destination.replace(/\/$/, '')}/index.mjs`;

    // The map form pins the destination, so no `_up_` rewriting applies.
    expect(expected).toBe('api-server/dist/index.mjs');
    expect(declaredApiEntryCandidates()).toContain(expected);
  });

  it('probes the API bundle destination before any legacy location', () => {
    const candidates = declaredApiEntryCandidates();
    const legacy = candidates.findIndex((candidate) => candidate.startsWith('_up_'));
    expect(candidates[0]).toBe('api-server/dist/index.mjs');
    // Older installers remain resolvable, just at lower priority.
    expect(legacy).toBeGreaterThan(0);
  });

  it('keeps the runtime destination aligned with the Rust lookup', () => {
    const map = resources as Record<string, string>;
    const runtimeDestination = map['runtime/'].replace(/\/$/, '');

    // main.rs joins resource_dir with "runtime" for both node.exe and the
    // media tools, so the packaged destination must be exactly that.
    expect(runtimeDestination).toBe('runtime');
    expect(mainRs).toMatch(
      new RegExp(`join\\("${runtimeDestination}"\\)\\.join\\(BUNDLED_NODE_FILE_NAME\\)`),
    );
    expect(mainRs).toMatch(
      new RegExp(`join\\("${runtimeDestination}"\\)\\.join\\("media-tools"\\)`),
    );
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

  // On Windows, tauri-utils resolve_resource_dir returns exe_dir directly:
  //
  //   if cfg!(target_os = "windows") || (... cargo output dir ...) {
  //     return Ok(exe_dir.to_path_buf());
  //   }
  //
  // There is no "resources" segment on Windows -- that is the macOS layout
  // (${exe_dir}/../Resources). So resources land beside the exe, which is
  // target/release/<resource> for a local build and $INSTDIR/<resource> once
  // NSIS installs (its Install section does SetOutPath $INSTDIR then writes
  // each resource to a relative /oname). A dir listing showing
  // target/release/runtime/node.exe is therefore the CORRECT layout, not a
  // misplaced file, and target/release/resources/ is expected NOT to exist.
  describe('windows resource root', () => {
    it('joins the runtime onto resource_dir with no "resources" segment', () => {
      // A literal "resources" join would look one level too deep on Windows
      // and would never find the runtime, regardless of what shipped.
      expect(mainRs).not.toMatch(/join\("resources"\)/);
      expect(mainRs).toMatch(/resource_dir\(\)/);
    });

    it('verifies the packaged layout at the exe directory, not a resources subdirectory', () => {
      const workflow = readFileSync(windowsWorkflowPath, 'utf8');

      // The check runs in target/release, which IS the resource root on
      // Windows. Rooting it at a "resources" subdirectory would probe a path
      // the application never reads.
      expect(workflow).toContain('working-directory: artifacts/archive-assistant/src-tauri/target/release');
      expect(workflow).not.toContain("Join-Path 'resources' $relative");
      expect(workflow).toContain("Test-Path -LiteralPath $relative");
    });

    it('asserts the bundled runtime and every media tool in the packaged layout', () => {
      const workflow = readFileSync(windowsWorkflowPath, 'utf8');

      // These are exactly what node_command and bundled_media_tools_path
      // resolve. Dropping any one of them reopens the silent-packaging gap.
      // Scoped to the packaged-layout step only. The earlier staging step
      // lists the same filenames, so searching the whole file would let an
      // assertion be deleted here and still be satisfied by the other block.
      const packagedStep = workflow.slice(workflow.indexOf('Verify the packaged resource layout'));
      expect(packagedStep).not.toBe('');

      // Matched as whole quoted list entries: a bare substring check would let
      // 'runtime/node.exe' be satisfied by 'runtime/media-tools/...'.
      const entries = Array.from(
        packagedStep.matchAll(/'([\w.-]+(?:\/[\w.-]+)+)'/g),
        (match) => match[1],
      );

      for (const relative of [
        'api-server/dist/index.mjs',
        'runtime/node.exe',
        'runtime/media-tools/ffmpeg.exe',
        'runtime/media-tools/ffprobe.exe',
        'runtime/media-tools/yt-dlp.exe',
      ]) {
        expect(entries).toContain(relative);
      }
    });
  });
});

/**
 * Regression cover for the packaged launch failure:
 *
 *   Error: EISDIR: illegal operation on a directory, lstat 'C:'
 *       at Object.realpathSync ... at resolveMainPath
 *
 * An installed build selected the source-tree API bundle -- the candidate
 * derived from the compile-time CARGO_MANIFEST_DIR, which still exists on the
 * machine that produced the installer -- and handed Node the canonicalized
 * form `\\?\C:\Projects\...\index.mjs`.
 */
describe('release build path selection', () => {
  it('excludes the source-tree API bundle from release builds', () => {
    const candidates = mainRs.match(/fn api_entry_candidates[\s\S]*?\n}/)![0];

    // The workspace candidate must sit behind #[cfg(debug_assertions)].
    const guardIndex = candidates.indexOf('#[cfg(debug_assertions)]');
    const workspaceIndex = candidates.indexOf('workspace_root()');
    expect(guardIndex).toBeGreaterThanOrEqual(0);
    expect(workspaceIndex).toBeGreaterThan(guardIndex);

    // Nothing may push an unguarded workspace candidate ahead of the packaged
    // resource candidates.
    expect(candidates).not.toMatch(
      /let mut candidates = vec!\[workspace_root\(\)/,
    );
  });

  it('strips the verbatim prefix from every path handed to the sidecar', () => {
    expect(mainRs).toMatch(/fn strip_verbatim_prefix\(path: PathBuf\) -> PathBuf/);

    // canonicalize() is the source of the prefix, so its result must be wrapped.
    expect(mainRs).toMatch(/strip_verbatim_prefix\([\s\S]{0,200}canonicalize\(\)/);

    // Each resource_dir consumer, and the environment values, must be covered.
    const stripCallCount = (mainRs.match(/strip_verbatim_prefix/g) ?? []).length;
    expect(stripCallCount).toBeGreaterThanOrEqual(6);
  });

  it('matches the shipped Rust implementation', () => {
    // Guards the port above from drifting away from main.rs.
    pinsRustImplementation();
  });

  it.each([
    ['resource_dir feeding the API entry candidates', /fn api_entry_candidates[\s\S]*?\n}/],
    ['resource_dir feeding the Node runtime lookup', /fn node_command[\s\S]*?\n}/],
    ['resource_dir feeding the media-tools lookup', /fn bundled_media_tools_path[\s\S]*?\n}/],
    // Every ARCHIVE_* value is resolved by Node in the sidecar, so a verbatim
    // path here fails the same way the entry path did -- just later, and with a
    // far less obvious error.
    ['environment values built by configured_path', /fn configured_path[\s\S]*?\n}/],
    ['the app data directory', /let app_data = app[\s\S]*?;/],
    ['the home directory used for the archive root', /let archive_root = app[\s\S]*?;/],
  ])('normalises %s', (_label, pattern) => {
    const block = mainRs.match(pattern);
    expect(block, 'block must exist in main.rs').not.toBeNull();
    expect(block![0]).toMatch(/strip_verbatim_prefix/);
  });

  it.each([
    [
      'the exact path from the failing installer',
      '\\\\?\\C:\\Projects\\SomeSafePortablesoftware\\artifacts\\api-server\\dist\\index.mjs',
      'C:\\Projects\\SomeSafePortablesoftware\\artifacts\\api-server\\dist\\index.mjs',
    ],
    [
      'a packaged resource path',
      '\\\\?\\C:\\Users\\lochi\\AppData\\Local\\ARCHIVE ASSISTANT\\_up_\\_up_\\api-server\\dist\\index.mjs',
      'C:\\Users\\lochi\\AppData\\Local\\ARCHIVE ASSISTANT\\_up_\\_up_\\api-server\\dist\\index.mjs',
    ],
    // Regression: this previously produced a bare "C:", which is
    // drive-relative and is exactly what Node lstats.
    ['a bare drive specifier', '\\\\?\\C:', 'C:\\'],
    ['a lowercase drive letter', '\\\\?\\d:\\Movies', 'd:\\Movies'],
    // Already-plain paths must pass through untouched.
    ['a plain drive path', 'C:\\Users\\lochi\\app.exe', 'C:\\Users\\lochi\\app.exe'],
    // A verbatim UNC path is deliberately left alone: unwrapping it correctly
    // requires restoring the leading "\\", which is not a safe blind edit.
    ['a verbatim UNC path', '\\\\?\\UNC\\server\\share\\f.mjs', '\\\\?\\UNC\\server\\share\\f.mjs'],
    ['a plain UNC path', '\\\\server\\share\\f.mjs', '\\\\server\\share\\f.mjs'],
  ])('normalises %s', (_label, input, expected) => {
    expect(stripVerbatimPrefix(input)).toBe(expected);
  });

  // The previous suite asserted only that the verbatim prefix was removed, so
  // it passed while the shipped code emitted a bare "C:" -- the precise shape
  // that crashes. These cases assert against Node's own resolver instead.
  it.each([
    ['\\\\?\\C:', 'a canonicalised drive root'],
    ['\\\\?\\C:\\', 'a canonicalised drive root with separator'],
    ['\\\\?\\C:\\Projects\\app\\dist\\index.mjs', 'a canonicalised source path'],
    [
      '\\\\?\\C:\\Users\\lochi\\AppData\\Local\\ARCHIVE ASSISTANT\\_up_\\_up_\\api-server\\dist\\index.mjs',
      'a canonicalised packaged resource path',
    ],
  ])('never yields a drive-relative path from %s (%s)', (input) => {
    const normalised = stripVerbatimPrefix(input);

    // A drive-relative path is "C:" or "C:foo" -- a drive with no root
    // separator. Node stats the bare root component and raises EISDIR.
    expect(normalised).not.toMatch(/^[A-Za-z]:(?![\\/])/);
    expect(nodeLstatTarget(normalised)).not.toBe('C:');
    expect(win32.isAbsolute(normalised)).toBe(true);
  });

  it('pins the exact shape that caused the reported crash', () => {
    // Bare "C:" is what Node reported lstat'ing. Confirm our understanding of
    // the failure is correct, then confirm the fix cannot produce it.
    expect(nodeLstatTarget('C:')).toBe('C:');
    expect(nodeLstatTarget('C:Projects\\index.mjs')).toBe('C:');
    expect(nodeLstatTarget('C:\\Projects\\index.mjs')).toBe('C:\\');

    expect(stripVerbatimPrefix('\\\\?\\C:')).toBe('C:\\');
    expect(nodeLstatTarget(stripVerbatimPrefix('\\\\?\\C:'))).toBe('C:\\');
  });

  it('guards the sidecar against a drive-relative entry path', () => {
    // Defence in depth: if normalisation ever regresses, the shell must report
    // the offending value rather than let Node fail with an opaque stack.
    expect(mainRs).toMatch(/fn reject_drive_relative/);
    expect(mainRs).toMatch(/reject_drive_relative\(found, "API bundle path"\)\?/);
    expect(mainRs).toMatch(/drive-relative path/);
  });

  it('produces a path Node resolves to a file rather than a drive root', () => {
    const verbatim =
      '\\\\?\\C:\\Projects\\SomeSafePortablesoftware\\artifacts\\api-server\\dist\\index.mjs';

    // Node parses "\\?\C:\..." as a UNC path: server "?", share "C:". Its
    // module resolver then stats the share component, which is the directory
    // "C:" -- producing EISDIR ... lstat 'C:'.
    expect(win32.parse(verbatim).root).toBe('\\\\?\\C:\\');

    // After stripping, the root is an ordinary drive and the basename is the
    // entry file, so resolveMainPath stats a real file.
    const stripped = stripVerbatimPrefix(verbatim);
    expect(win32.parse(stripped).root).toBe('C:\\');
    expect(win32.basename(stripped)).toBe('index.mjs');
    expect(win32.isAbsolute(stripped)).toBe(true);
  });
});

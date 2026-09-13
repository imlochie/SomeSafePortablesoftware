/**
 * TEMPORARY launch instrumentation for the Windows desktop shell.
 *
 * The packaged app fails with `EISDIR: illegal operation on a directory,
 * lstat 'C:'` from inside Node, meaning the sidecar launched correctly and the
 * fault is in what the API server received or derived at startup. The desktop
 * shell is a GUI-subsystem binary with no console, so Rust-side `eprintln!`
 * output is invisible; only the child's stdout/stderr reaches the startup
 * dialog. This module reports the launch context through that channel.
 *
 * Remove once the `C:` source is identified.
 */

const REPORTED_ENVIRONMENT_KEYS = [
  "ARCHIVE_DB_PATH",
  "ARCHIVE_DATA_PATH",
  "ARCHIVE_DOWNLOAD_PATH",
  "ARCHIVE_LIBRARY_PATH",
  "ARCHIVE_TEMP_PATH",
  "ARCHIVE_MEDIA_TOOLS_DIR",
  "ARCHIVE_MOCK_MODE",
  "YT_DLP_PATH",
  "FFMPEG_PATH",
  "FFPROBE_PATH",
] as const;

const PREFIX = "[ARCHIVE LAUNCH]";

/**
 * Renders the launch context as plain lines.
 *
 * Values are quoted with JSON.stringify so an empty string, a bare drive
 * specifier such as "C:", or a stray trailing space is visible rather than
 * blending into the surrounding text -- exactly the shapes that produce an
 * `lstat 'C:'`. Kept free of the substrings the desktop shell's diagnostic
 * redactor truncates on (token, secret, password, cookie, authorization,
 * api_key), so these lines survive intact.
 */
export function describeLaunchContext(
  environment: NodeJS.ProcessEnv = process.env,
  argv: readonly string[] = process.argv,
  workingDirectory: string = safeCwd(),
): string[] {
  const lines = [
    `${PREFIX} platform: ${process.platform} ${process.arch} node ${process.version}`,
    `${PREFIX} execPath: ${JSON.stringify(process.execPath)}`,
    `${PREFIX} argv: ${JSON.stringify(argv)}`,
    `${PREFIX} cwd: ${JSON.stringify(workingDirectory)}`,
  ];

  for (const key of REPORTED_ENVIRONMENT_KEYS) {
    const value = environment[key];
    lines.push(
      `${PREFIX} ${key}: ${value === undefined ? "<unset>" : JSON.stringify(value)}`,
    );
  }

  return lines;
}

function safeCwd(): string {
  try {
    return process.cwd();
  } catch (error) {
    // process.cwd() itself throws if the inherited working directory no longer
    // exists, which would be a direct explanation for a bogus resolved path.
    return `<unavailable: ${(error as Error).message}>`;
  }
}

function report(): void {
  for (const line of describeLaunchContext()) {
    console.error(line);
  }
}

/**
 * Emits the launch context immediately, and again on a fatal startup error.
 *
 * The desktop shell keeps only the last handful of diagnostic lines, so an
 * emission at load alone can be pushed out by ordinary startup logging.
 * Re-emitting alongside the failure guarantees the context and the error
 * appear together in the report.
 */
function installLaunchDiagnostics(): void {
  report();

  const reportFatal = (label: string) => (error: unknown) => {
    console.error(`${PREFIX} ${label} -- context at failure:`);
    report();
    console.error(
      `${PREFIX} ${label}:`,
      error instanceof Error ? (error.stack ?? error.message) : String(error),
    );
    // Registering these listeners suppresses Node's default behaviour of
    // terminating on a fatal error. Without an explicit exit the sidecar would
    // hang instead of crashing, and the shell would report a readiness timeout
    // rather than the real error -- destroying the signal we are here to
    // capture. Exit code 1 preserves the pre-instrumentation semantics.
    process.exit(1);
  };

  process.on("uncaughtException", reportFatal("uncaughtException"));
  process.on("unhandledRejection", reportFatal("unhandledRejection"));
}

// Installed on import so this runs before any other module in the graph is
// evaluated. See the note in src/index.ts.
installLaunchDiagnostics();

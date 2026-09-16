import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Expands a configured runtime path to its absolute form.
 *
 * `~/…` resolves against the real user profile (USERPROFILE on Windows, HOME
 * elsewhere); anything else resolves against the working directory. This is
 * the single shared implementation — the download-job boundary, the local
 * inspection guard, the scanner roots, and the storage volumes must all see
 * exactly the same absolute path for the same configured value, or a job
 * downloads into one interpretation of "~/ARCHIVE/tmp" while the safety guard
 * checks another.
 *
 * `process.env.HOME` is not a substitute: it is routinely unset on Windows,
 * where the profile lives in USERPROFILE. Falling back to the working
 * directory there would silently relocate the archive.
 */
export function expandPath(value: string): string {
  const expanded = value.startsWith("~/")
    ? join(homedir() || process.cwd(), value.slice(2))
    : value;
  return resolve(expanded);
}

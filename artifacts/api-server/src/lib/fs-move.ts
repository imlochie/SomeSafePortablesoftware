import { constants } from "node:fs";
import fs from "node:fs/promises";

/**
 * Moves one regular file to a new path, within a volume or across volumes.
 *
 * Same-volume moves are a plain rename. A cross-volume move (temporary
 * directory on one drive, archive volume on another — the common Windows
 * layout, and equally possible on Linux) fails with EXDEV, so it falls back to
 * an exclusive copy, a size verification, and only then removal of the source.
 * The fallback preserves the caller's overwrite ban: `COPYFILE_EXCL` refuses
 * to replace an existing target instead of silently clobbering it.
 *
 * On Windows a cross-drive rename can also surface as EPERM rather than EXDEV;
 * the copy fallback is attempted there too, and any genuine permission problem
 * re-surfaces from the copy itself.
 */
export async function moveFile(sourcePath: string, targetPath: string): Promise<void> {
  try {
    await fs.rename(sourcePath, targetPath);
    return;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    const crossVolume =
      code === "EXDEV" || (code === "EPERM" && process.platform === "win32");
    if (!crossVolume) throw error;
  }

  // Cross-volume fallback: copy exclusively, verify, then remove the source.
  await fs.copyFile(sourcePath, targetPath, constants.COPYFILE_EXCL);
  const [sourceStat, targetStat] = await Promise.all([
    fs.stat(sourcePath),
    fs.stat(targetPath),
  ]);
  if (sourceStat.size !== targetStat.size) {
    await fs.rm(targetPath, { force: true });
    throw new Error(
      `The cross-volume move of ${sourcePath} was incomplete; the partial copy was removed and the source was left in place.`,
    );
  }
  await fs.rm(sourcePath, { force: true });
}

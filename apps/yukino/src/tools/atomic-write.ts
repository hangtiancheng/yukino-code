import { randomUUID } from "node:crypto";
import { lstat, open, realpath, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

import { PRIVATE_FILE_MODE } from "@/storage/constants.js";
import {
  isPrivateStatePath,
  mkdirPrivateSync,
  protectPrivateFileSync,
} from "@/storage/private.js";
import { isRecord } from "@/utils/index.js";

export async function writeFileAtomically(
  filePath: string,
  content: string,
  signal?: AbortSignal,
): Promise<void> {
  const privateState = isPrivateStatePath(filePath);
  if (privateState) {
    mkdirPrivateSync(dirname(filePath));
  }
  const entry = await lstat(filePath).catch((error: unknown) => {
    if (!isRecord(error) || error.code !== "ENOENT") {
      throw error;
    }
    return undefined;
  });
  if (privateState && entry) {
    protectPrivateFileSync(filePath);
  }
  const target = entry?.isSymbolicLink() ? await realpath(filePath) : filePath;
  const existing = entry?.isSymbolicLink() ? await stat(target) : entry;
  if (existing && !existing.isFile()) {
    throw new Error("File writes require a regular file.");
  }
  const mode = privateState
    ? PRIVATE_FILE_MODE
    : existing
      ? existing.mode & 0o777
      : undefined;
  const temporary = join(dirname(target), `.yukino-${randomUUID()}.tmp`);
  try {
    signal?.throwIfAborted();
    const file = await open(temporary, "wx", mode);
    try {
      await file.writeFile(content, { encoding: "utf8", signal });
      if (mode !== undefined && process.platform !== "win32") {
        await file.chmod(mode);
      }
      await file.sync();
    } finally {
      await file.close();
    }
    signal?.throwIfAborted();
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
}

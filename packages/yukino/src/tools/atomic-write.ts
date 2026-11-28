import { lstat } from "node:fs/promises";
import { dirname } from "node:path";

import writeFile from "write-file-atomic";

import { PRIVATE_FILE_MODE } from "@/storage/constants.js";
import {
  isPrivateStatePath,
  mkdirPrivateSync,
  protectPrivateFileSync,
} from "@/storage/private.js";
import { isRecord } from "@/utils/record.js";

export async function writeFileAtomically(
  filePath: string,
  content: string,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
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
  if (entry && !entry.isFile() && !entry.isSymbolicLink()) {
    throw new Error("File writes require a regular file.");
  }
  if (privateState && entry) {
    protectPrivateFileSync(filePath);
  }
  signal?.throwIfAborted();
  await writeFile(filePath, content, {
    ...(privateState ? { mode: PRIVATE_FILE_MODE } : {}),
    tmpfileCreated: () => signal?.throwIfAborted(),
  });
}

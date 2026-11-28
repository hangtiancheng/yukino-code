import { randomUUID } from "node:crypto";
import { constants, lstatSync } from "node:fs";
import { open, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

import { z } from "zod";

import {
  MAX_TRUST_RECORD_BYTES,
  PROJECT_ID_RE,
  TRUST_DIR_NAME,
  TRUST_VERSION,
  UNSAFE_TRUST_PATH_ERROR,
} from "@/project/constants.js";
import { yukinoPath } from "@/storage/index.js";
import { mkdirPrivateSync } from "@/storage/private.js";

const TrustRecordSchema = z.strictObject({
  version: z.literal(TRUST_VERSION),
  cwd: z.string(),
  identity: z.string().regex(PROJECT_ID_RE),
  fingerprint: z.string().regex(PROJECT_ID_RE),
});
type TrustRecord = z.infer<typeof TrustRecordSchema>;

function trustPath(identity: string): string {
  if (!PROJECT_ID_RE.test(identity)) {
    throw new Error(UNSAFE_TRUST_PATH_ERROR);
  }
  return yukinoPath(TRUST_DIR_NAME, `${identity}.json`);
}

function validateStorage(path: string): void {
  const root = yukinoPath();
  for (const directory of [root, dirname(path)]) {
    const stat = lstatSync(directory, { throwIfNoEntry: false });
    if (!stat) {
      continue;
    }
    if (
      stat.isSymbolicLink() ||
      !stat.isDirectory() ||
      (directory !== root && (stat.mode & 0o077) !== 0)
    ) {
      throw new Error(UNSAFE_TRUST_PATH_ERROR);
    }
  }
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (
    stat &&
    (stat.isSymbolicLink() ||
      !stat.isFile() ||
      (stat.mode & 0o077) !== 0 ||
      stat.nlink !== 1)
  ) {
    throw new Error(UNSAFE_TRUST_PATH_ERROR);
  }
}

export async function readProjectTrust(
  identity: string,
): Promise<TrustRecord | undefined> {
  const path = trustPath(identity);
  validateStorage(path);
  let file;
  try {
    file = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
  try {
    const stat = await file.stat();
    if (
      !stat.isFile() ||
      stat.size > MAX_TRUST_RECORD_BYTES ||
      stat.nlink !== 1 ||
      (stat.mode & 0o077) !== 0
    ) {
      throw new Error(UNSAFE_TRUST_PATH_ERROR);
    }
    let raw: unknown;
    try {
      raw = JSON.parse(await file.readFile("utf8"));
    } catch {
      return undefined;
    }
    const result = TrustRecordSchema.safeParse(raw);
    return result.success ? result.data : undefined;
  } finally {
    await file.close();
  }
}

export async function writeProjectTrust(
  cwd: string,
  identity: string,
  fingerprint: string,
): Promise<void> {
  const path = trustPath(identity);
  // Directory creation/tightening happens only after an explicit persistent grant.
  mkdirPrivateSync(dirname(path));
  validateStorage(path);
  const temporary = join(dirname(path), `.${identity}.${randomUUID()}.tmp`);
  const file = await open(
    temporary,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await file.writeFile(
      JSON.stringify({ version: TRUST_VERSION, cwd, identity, fingerprint }),
      "utf8",
    );
    await file.sync();
    await file.close();
    validateStorage(path);
    await rename(temporary, path);
    const directory = await open(
      dirname(path),
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    await file.close();
    await unlink(temporary).catch((error: unknown) => {
      if (!(
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      )) {
        throw error;
      }
    });
  }
}

export async function removeProjectTrust(identity: string): Promise<void> {
  const path = trustPath(identity);
  validateStorage(path);
  try {
    await unlink(path);
  } catch (error) {
    if (!(
      error instanceof Error &&
      "code" in error &&
      error.code === "ENOENT"
    )) {
      throw error;
    }
  }
}

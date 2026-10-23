import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
  type WriteFileOptions,
} from "node:fs";
import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";

import { isPathWithin } from "@yukino.js/utils/paths.js";

import {
  PRIVATE_DIR_MODE,
  PRIVATE_FILE_MODE,
  PRIVATE_STATE_NOT_FILE_ERROR,
  PUBLIC_STATE_SEGMENTS,
  YUKINO_DIR_NAME,
} from "./constants.js";

export function isPrivateStatePath(path: string): boolean {
  const root = join(homedir(), YUKINO_DIR_NAME);
  const absolute = resolve(path);
  if (!isPathWithin(root, absolute)) {
    return false;
  }
  const first = relative(root, absolute).split(sep)[0];
  return !PUBLIC_STATE_SEGMENTS.has(first);
}

export function mkdirPrivateSync(
  path: string,
  _options?: { recursive?: boolean },
): void {
  const absolute = resolve(path);
  const root = join(homedir(), YUKINO_DIR_NAME);
  if (!isPathWithin(root, absolute)) {
    mkdirSync(absolute, { recursive: true, mode: PRIVATE_DIR_MODE });
    return;
  }
  // Tighten only Yukino state ancestors, never HOME or workspace directories.
  const segments = relative(root, absolute).split(sep).filter(Boolean);
  let directory = root;
  for (let i = -1; i < segments.length; i++) {
    if (i >= 0) {
      directory = join(directory, segments[i]);
    }
    const existing = lstatSync(directory, { throwIfNoEntry: false });
    if (existing?.isSymbolicLink() || (existing && !existing.isDirectory())) {
      throw new Error(
        `Private state directory must be a real directory: ${directory}`,
      );
    }
    if (!existing) {
      try {
        mkdirSync(directory, { mode: PRIVATE_DIR_MODE });
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !("code" in error) ||
          error.code !== "EEXIST"
        ) {
          throw error;
        }
        const raced = lstatSync(directory);
        if (raced.isSymbolicLink() || !raced.isDirectory()) {
          throw error;
        }
      }
    }
    if (process.platform !== "win32") {
      const fd = openSync(
        directory,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      try {
        fchmodSync(fd, PRIVATE_DIR_MODE);
      } finally {
        closeSync(fd);
      }
    }
  }
}

function fileFlags(flag: string | number): number {
  if (typeof flag === "number") {
    return flag;
  }
  switch (flag) {
    case "r":
      return constants.O_RDONLY;
    case "w":
      return constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC;
    case "wx":
      return (
        constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_TRUNC |
        constants.O_EXCL
      );
    case "a":
      return constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND;
    default:
      throw new Error(`Unsupported private file flag: ${flag}`);
  }
}

export function openPrivateFileSync(
  path: string,
  flag: string | number,
  _mode = PRIVATE_FILE_MODE,
): number {
  mkdirPrivateSync(dirname(path));
  const flags = fileFlags(flag);
  // mode alone does not tighten existing files; chmod the opened inode before
  // truncating or appending. O_NOFOLLOW prevents chmod of a linked source file.
  const fd = openSync(
    path,
    (flags & ~constants.O_TRUNC) | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    PRIVATE_FILE_MODE,
  );
  try {
    if (!fstatSync(fd).isFile()) {
      throw new Error(PRIVATE_STATE_NOT_FILE_ERROR);
    }
    if (process.platform !== "win32") {
      fchmodSync(fd, PRIVATE_FILE_MODE);
    }
    if (flags & constants.O_TRUNC) {
      ftruncateSync(fd, 0);
    }
    return fd;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

export function protectPrivateFileSync(path: string): void {
  closeSync(openPrivateFileSync(path, "r"));
}

export function writePrivateFileSync(
  path: string,
  data: string | Uint8Array,
  options?: WriteFileOptions,
): void {
  const opts = typeof options === "string" ? { encoding: options } : options;
  const fd = openPrivateFileSync(path, opts?.flag ?? "w");
  try {
    writeFileSync(fd, data, opts);
  } finally {
    closeSync(fd);
  }
}

export function appendPrivateFileSync(
  path: string,
  data: string | Uint8Array,
  encoding: BufferEncoding = "utf8",
): void {
  writePrivateFileSync(path, data, { flag: "a", encoding });
}

export function readPrivateFileSync(
  path: string,
  encoding: BufferEncoding,
): string;
export function readPrivateFileSync(path: string): Buffer<ArrayBuffer>;
export function readPrivateFileSync(
  path: string,
  encoding?: BufferEncoding,
): string | Buffer {
  const fd = openPrivateFileSync(path, "r");
  try {
    return encoding ? readFileSync(fd, encoding) : readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}

export async function writePrivateFile(
  path: string,
  data: string | Uint8Array,
  encoding: BufferEncoding = "utf8",
): Promise<void> {
  mkdirPrivateSync(dirname(path));
  const file = await open(
    path,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_NOFOLLOW |
      constants.O_NONBLOCK,
    PRIVATE_FILE_MODE,
  );
  try {
    if (!(await file.stat()).isFile()) {
      throw new Error(PRIVATE_STATE_NOT_FILE_ERROR);
    }
    if (process.platform !== "win32") {
      await file.chmod(PRIVATE_FILE_MODE);
    }
    await file.truncate(0);
    await file.writeFile(data, encoding);
  } finally {
    await file.close();
  }
}

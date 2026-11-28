import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readSync,
  realpathSync,
  rmSync,
  type Stats,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { setImmediate } from "node:timers/promises";

import {
  INVALID_SESSION_RECORD,
  MAX_SESSION_STREAM_BYTES,
  SESSION_TRANSPORT_CHUNK_BYTES,
  SESSION_TRANSFER_TEMP_PREFIX,
  UNSAFE_SESSION_TRANSFER_FILE,
} from "@/session/constants.js";
import {
  SessionJsonlParser,
  sessionJsonlChunks,
  sessionUtf8Chunks,
  type SessionDocument,
} from "@/session/records.js";
import {
  prepareSessionImport,
  sessionHtmlParts,
  type SessionExportOptions,
} from "@/session/transfer.js";
import { PRIVATE_FILE_MODE } from "@/storage/constants.js";
import { writeAllSync } from "@/storage/file-io.js";
import { cancelOnSignal } from "@/utils/cancel.js";

export interface SessionStreamOptions {
  signal?: AbortSignal;
}

async function* transferChunks(
  source: AsyncIterable<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<Uint8Array> {
  signal?.throwIfAborted();
  const iterator = source[Symbol.asyncIterator]();
  let complete = false;
  try {
    while (true) {
      const result = await cancelOnSignal(() => iterator.next(), signal);
      signal?.throwIfAborted();
      if (result.done) {
        complete = true;
        return;
      }
      yield result.value;
    }
  } finally {
    if (!complete) {
      // A producer's return() may wait for its pending next().
      void Promise.resolve()
        .then(() => iterator.return?.())
        .catch(() => undefined);
    }
  }
}

export async function parseSessionImportStream(
  source: AsyncIterable<Uint8Array>,
  options: SessionStreamOptions = {},
): Promise<SessionDocument> {
  const { signal } = options;
  const parser = new SessionJsonlParser();
  for await (const chunk of transferChunks(source, signal)) {
    parser.push(chunk);
    await setImmediate(undefined, { signal });
  }
  signal?.throwIfAborted();
  return prepareSessionImport(parser.finish({ completeTools: true }));
}

export async function* sessionExportStream(
  document: SessionDocument,
  options: SessionExportOptions,
  revalidate: () => void,
): AsyncGenerator<Uint8Array> {
  options.signal?.throwIfAborted();
  revalidate();
  const chunks =
    options.format === "jsonl"
      ? sessionJsonlChunks(document)
      : sessionUtf8Chunks(sessionHtmlParts(document));
  for (const chunk of chunks) {
    await setImmediate(undefined, { signal: options.signal });
    options.signal?.throwIfAborted();
    yield chunk;
  }
  options.signal?.throwIfAborted();
  revalidate();
}

function checkedParent(path: string): Stats {
  if (
    !isAbsolute(path) ||
    resolve(path) !== path ||
    realpathSync(dirname(path)) !== dirname(path)
  ) {
    throw new Error(UNSAFE_SESSION_TRANSFER_FILE);
  }
  const parent = lstatSync(dirname(path));
  if (!parent.isDirectory() || parent.isSymbolicLink()) {
    throw new Error(UNSAFE_SESSION_TRANSFER_FILE);
  }
  return parent;
}
function sameInode(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}
function recheckParent(path: string, parent: Stats): void {
  if (!sameInode(checkedParent(path), parent)) {
    throw new Error(UNSAFE_SESSION_TRANSFER_FILE);
  }
}

export async function* sessionImportFileBytes(
  path: string,
  options: SessionStreamOptions = {},
): AsyncGenerator<Uint8Array> {
  options.signal?.throwIfAborted();
  const parent = checkedParent(path);
  const named = lstatSync(path);
  if (!named.isFile() || named.isSymbolicLink() || named.nlink !== 1) {
    throw new Error(UNSAFE_SESSION_TRANSFER_FILE);
  }
  const fd = openSync(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1 || !sameInode(before, named)) {
      throw new Error(UNSAFE_SESSION_TRANSFER_FILE);
    }
    if (before.size > MAX_SESSION_STREAM_BYTES) {
      throw new Error(`${INVALID_SESSION_RECORD}: byte limit exceeded.`);
    }
    let total = 0;
    while (true) {
      options.signal?.throwIfAborted();
      const buffer = Buffer.allocUnsafe(SESSION_TRANSPORT_CHUNK_BYTES);
      const count = readSync(fd, buffer);
      if (!count) {
        break;
      }
      total += count;
      if (total > MAX_SESSION_STREAM_BYTES) {
        throw new Error(`${INVALID_SESSION_RECORD}: byte limit exceeded.`);
      }
      yield buffer.subarray(0, count);
      await setImmediate(undefined, { signal: options.signal });
    }
    const after = fstatSync(fd);
    recheckParent(path, parent);
    if (
      total !== before.size ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs ||
      after.nlink !== 1 ||
      !sameInode(lstatSync(path), before)
    ) {
      throw new Error(UNSAFE_SESSION_TRANSFER_FILE);
    }
  } finally {
    closeSync(fd);
  }
}

export async function writeSessionExportFile(
  path: string,
  source: AsyncIterable<Uint8Array>,
  options: SessionStreamOptions = {},
  revalidate: () => void = () => {},
): Promise<void> {
  options.signal?.throwIfAborted();
  const parent = checkedParent(path);
  if (lstatSync(path, { throwIfNoEntry: false })) {
    throw new Error(`Session export destination already exists: ${path}`);
  }
  const temporaryDirectory = mkdtempSync(
    join(dirname(path), SESSION_TRANSFER_TEMP_PREFIX),
  );
  const temporary = join(temporaryDirectory, randomUUID());
  let fd: number | undefined;
  try {
    recheckParent(path, parent);
    fd = openSync(
      temporary,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      PRIVATE_FILE_MODE,
    );
    let total = 0;
    for await (const chunk of transferChunks(source, options.signal)) {
      total += chunk.byteLength;
      if (
        chunk.byteLength > SESSION_TRANSPORT_CHUNK_BYTES ||
        total > MAX_SESSION_STREAM_BYTES
      ) {
        throw new Error(`${INVALID_SESSION_RECORD}: byte limit exceeded.`);
      }
      writeAllSync(fd, chunk);
    }
    fsyncSync(fd);
    options.signal?.throwIfAborted();
    revalidate();
    recheckParent(path, parent);
    const file = fstatSync(fd);
    if (!sameInode(lstatSync(temporary), file) || file.nlink !== 1) {
      throw new Error(UNSAFE_SESSION_TRANSFER_FILE);
    }
    linkSync(temporary, path);
  } finally {
    if (fd !== undefined) {
      closeSync(fd);
    }
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

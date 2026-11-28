import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  type BigIntStats,
} from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

import { z } from "zod";

import {
  MAX_SESSION_BYTES,
  SESSION_LEASE_ACTIVE,
  SESSION_LEASE_INVALID,
  SESSION_LEASE_FILE_EXTENSION,
  SESSION_LEASE_PENDING_RE,
  SESSION_LEASE_KINDS,
  SESSION_LEASE_MAX_BYTES,
  SESSION_LEASE_SUFFIX,
  SESSION_LEASE_TOKEN_RE,
  SESSION_LEASE_VERSION,
  SESSION_NOT_FOUND,
  SESSION_STORAGE_CHANGED,
  SESSION_STORAGE_UNSAFE,
  SHA256_RE,
} from "@/session/constants.js";
import { getSessionFilePath, parseSessionJsonl } from "@/session/records.js";
import { PRIVATE_FILE_MODE, SESSION_ID_RE } from "@/storage/constants.js";
import { getYukinoDir, projectKey } from "@/storage/index.js";
import { mkdirPrivateSync } from "@/storage/private.js";
import { withFileSyncLock } from "@/teams/file-lock.js";
import { canonicalPath, isPathWithin } from "@/utils/paths.js";

export interface SessionStorageTarget {
  cwd: string;
  sessionId: string;
}

export interface SessionStorageIdentity extends SessionStorageTarget {
  storageRoot: string;
  projectKey: string;
  transcriptPath: string;
}

export const SessionStorageFingerprintSchema = z.strictObject({
  path: z.string().min(1),
  kind: z.enum(["file", "directory"]),
  device: z.string().regex(/^\d+$/u),
  inode: z.string().regex(/^\d+$/u),
  size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  modified: z.string(),
  born: z.string(),
  sha256: z.string().regex(SHA256_RE).nullable(),
});
export type SessionStorageFingerprint = z.infer<
  typeof SessionStorageFingerprintSchema
>;

export function sessionStorageIdentity(
  target: SessionStorageTarget,
): SessionStorageIdentity {
  const cwd = canonicalPath(target.cwd);
  const rawRoot = getYukinoDir();
  const storageRoot = join(canonicalPath(dirname(rawRoot)), basename(rawRoot));
  const transcriptPath = join(
    storageRoot,
    relative(rawRoot, getSessionFilePath(cwd, target.sessionId)),
  );
  return {
    cwd,
    sessionId: target.sessionId,
    storageRoot,
    projectKey: projectKey(cwd),
    transcriptPath,
  };
}

function ownedStat(info: BigIntStats): void {
  if (
    info.isSymbolicLink() ||
    (!info.isFile() && !info.isDirectory()) ||
    (info.isFile() && info.nlink !== 1n) ||
    (process.getuid && info.uid !== BigInt(process.getuid()))
  ) {
    throw new Error(SESSION_STORAGE_UNSAFE);
  }
}

export function assertSessionStoragePath(root: string, path: string): void {
  if (resolve(path) !== path || !isPathWithin(root, path)) {
    throw new Error(SESSION_STORAGE_UNSAFE);
  }
  const parts = relative(root, path).split(sep).filter(Boolean);
  let current = root;
  for (let index = -1; index < parts.length; index++) {
    if (index >= 0) {
      current = join(current, parts[index]);
    }
    const info = lstatSync(current, { bigint: true, throwIfNoEntry: false });
    if (!info) {
      continue;
    }
    ownedStat(info);
    if (index < parts.length - 1 && !info.isDirectory()) {
      throw new Error(SESSION_STORAGE_UNSAFE);
    }
  }
}

function fingerprint(
  path: string,
  info: BigIntStats,
  sha256: string | null,
): SessionStorageFingerprint {
  return {
    path,
    kind: info.isDirectory() ? "directory" : "file",
    device: String(info.dev),
    inode: String(info.ino),
    size: info.isDirectory() ? 0 : Number(info.size),
    modified: info.isDirectory() ? "" : String(info.mtimeNs),
    born: String(info.birthtimeNs),
    sha256,
  };
}

export function inspectSessionStoragePath(
  root: string,
  path: string,
  maxBytes = MAX_SESSION_BYTES,
): { fingerprint: SessionStorageFingerprint; bytes?: Buffer } | null {
  assertSessionStoragePath(root, path);
  const named = lstatSync(path, { bigint: true, throwIfNoEntry: false });
  if (!named) {
    return null;
  }
  if (named.isDirectory()) {
    return { fingerprint: fingerprint(path, named, null) };
  }
  if (named.size > BigInt(maxBytes)) {
    throw new Error(SESSION_STORAGE_UNSAFE);
  }
  const fd = openSync(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const before = fstatSync(fd, { bigint: true });
    ownedStat(before);
    if (!before.isFile() || before.size > BigInt(maxBytes)) {
      throw new Error(SESSION_STORAGE_UNSAFE);
    }
    const bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!count) {
        throw new Error(SESSION_STORAGE_CHANGED);
      }
      offset += count;
    }
    const after = fstatSync(fd, { bigint: true });
    const current = lstatSync(path, { bigint: true });
    assertSessionStoragePath(root, path);
    if (
      before.dev !== named.dev ||
      before.ino !== named.ino ||
      before.dev !== current.dev ||
      before.ino !== current.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs ||
      after.nlink !== 1n ||
      current.nlink !== 1n ||
      current.isSymbolicLink() ||
      BigInt(bytes.length) !== before.size
    ) {
      throw new Error(SESSION_STORAGE_CHANGED);
    }
    return {
      fingerprint: fingerprint(
        path,
        after,
        createHash("sha256").update(bytes).digest("hex"),
      ),
      bytes,
    };
  } finally {
    closeSync(fd);
  }
}

export function withSessionStorageLock<T>(
  target: SessionStorageTarget,
  operation: (identity: SessionStorageIdentity) => T,
): T {
  const identity = sessionStorageIdentity(target);
  assertSessionStoragePath(identity.storageRoot, identity.transcriptPath);
  assertSessionStoragePath(
    identity.storageRoot,
    `${identity.transcriptPath}.lock`,
  );
  return withFileSyncLock(identity.transcriptPath, () => {
    assertSessionStoragePath(identity.storageRoot, identity.transcriptPath);
    return operation(identity);
  });
}

export const SessionRunLeaseSchema = z.strictObject({
  version: z.literal(SESSION_LEASE_VERSION),
  cwd: z.string().min(1),
  projectKey: z.string().regex(SHA256_RE),
  sessionId: z.string().regex(SESSION_ID_RE),
  ownerToken: z.string().regex(SESSION_LEASE_TOKEN_RE),
  pid: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  kind: z.enum(SESSION_LEASE_KINDS),
  createdAt: z.number().int().nonnegative(),
});
export type SessionRunLease = Readonly<z.infer<typeof SessionRunLeaseSchema>>;
export interface SessionRunLeaseHandle {
  readonly lease: SessionRunLease;
  release(): void;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(
      error instanceof Error &&
      "code" in error &&
      error.code === "ESRCH"
    );
  }
}

function leaseDirectory(identity: SessionStorageIdentity): string {
  return `${identity.transcriptPath}${SESSION_LEASE_SUFFIX}`;
}

function readLease(
  identity: SessionStorageIdentity,
  path: string,
): SessionRunLease {
  const inspected = inspectSessionStoragePath(
    identity.storageRoot,
    path,
    SESSION_LEASE_MAX_BYTES,
  );
  const info = lstatSync(path);
  if (
    !inspected?.bytes ||
    !info.isFile() ||
    (process.platform !== "win32" && (info.mode & 0o077) !== 0)
  ) {
    throw new Error(SESSION_LEASE_INVALID);
  }
  const raw: unknown = JSON.parse(inspected.bytes.toString("utf8"));
  const lease = SessionRunLeaseSchema.parse(raw);
  if (
    lease.cwd !== identity.cwd ||
    lease.projectKey !== identity.projectKey ||
    lease.sessionId !== identity.sessionId ||
    basename(path) !== `${lease.ownerToken}${SESSION_LEASE_FILE_EXTENSION}`
  ) {
    throw new Error(SESSION_LEASE_INVALID);
  }
  return Object.freeze(lease);
}

export function inspectSessionRunLeasesUnderLock(
  identity: SessionStorageIdentity,
): readonly SessionRunLease[] {
  const directory = leaseDirectory(identity);
  assertSessionStoragePath(identity.storageRoot, directory);
  const info = lstatSync(directory, { throwIfNoEntry: false });
  if (!info) {
    return Object.freeze([]);
  }
  if (
    !info.isDirectory() ||
    (process.platform !== "win32" && (info.mode & 0o077) !== 0)
  ) {
    throw new Error(SESSION_LEASE_INVALID);
  }
  const active: SessionRunLease[] = [];
  for (const name of readdirSync(directory).sort()) {
    const path = join(directory, name);
    const pending = SESSION_LEASE_PENDING_RE.exec(name);
    if (pending) {
      const inspected = inspectSessionStoragePath(
        identity.storageRoot,
        path,
        SESSION_LEASE_MAX_BYTES,
      );
      const pid = Number(pending[1]);
      if (!inspected?.bytes || !Number.isSafeInteger(pid)) {
        throw new Error(SESSION_LEASE_INVALID);
      }
      if (processAlive(pid)) {
        throw new Error(SESSION_LEASE_ACTIVE);
      }
      const current = inspectSessionStoragePath(
        identity.storageRoot,
        path,
        SESSION_LEASE_MAX_BYTES,
      );
      if (
        JSON.stringify(current?.fingerprint) !==
          JSON.stringify(inspected.fingerprint) ||
        processAlive(pid)
      ) {
        throw new Error(SESSION_LEASE_INVALID);
      }
      unlinkSync(path);
      continue;
    }
    const lease = readLease(identity, path);
    if (processAlive(lease.pid)) {
      active.push(lease);
    } else {
      const current = readLease(identity, path);
      if (
        JSON.stringify(current) !== JSON.stringify(lease) ||
        processAlive(current.pid)
      ) {
        throw new Error(SESSION_LEASE_INVALID);
      }
      unlinkSync(path);
    }
  }
  return Object.freeze(active);
}

export function assertNoSessionRunLeasesUnderLock(
  identity: SessionStorageIdentity,
): void {
  if (inspectSessionRunLeasesUnderLock(identity).length) {
    throw new Error(SESSION_LEASE_ACTIVE);
  }
}

export function listSessionRunLeases(
  target: SessionStorageTarget,
): readonly SessionRunLease[] {
  return withSessionStorageLock(target, inspectSessionRunLeasesUnderLock);
}

export function acquireSessionRunLease(
  target: SessionStorageTarget,
  kind: SessionRunLease["kind"],
): SessionRunLeaseHandle {
  return withSessionStorageLock(target, (identity) => {
    const transcript = inspectSessionStoragePath(
      identity.storageRoot,
      identity.transcriptPath,
    );
    if (
      !transcript?.bytes ||
      parseSessionJsonl(transcript.bytes.toString("utf8")).header.sessionId !==
        identity.sessionId
    ) {
      throw new Error(SESSION_NOT_FOUND);
    }
    inspectSessionRunLeasesUnderLock(identity);
    const lease = Object.freeze(
      SessionRunLeaseSchema.parse({
        version: SESSION_LEASE_VERSION,
        cwd: identity.cwd,
        projectKey: identity.projectKey,
        sessionId: identity.sessionId,
        ownerToken: randomBytes(32).toString("hex"),
        pid: process.pid,
        kind,
        createdAt: Date.now(),
      }),
    );
    const directory = leaseDirectory(identity);
    mkdirPrivateSync(directory);
    assertSessionStoragePath(identity.storageRoot, directory);
    const path = join(
      directory,
      `${lease.ownerToken}${SESSION_LEASE_FILE_EXTENSION}`,
    );
    const pending = join(
      directory,
      `${process.pid}-${lease.ownerToken}.pending`,
    );
    const fd = openSync(
      pending,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      PRIVATE_FILE_MODE,
    );
    try {
      try {
        writeFileSync(fd, JSON.stringify(lease));
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(pending, path);
    } catch (error) {
      assertSessionStoragePath(identity.storageRoot, pending);
      if (lstatSync(pending, { throwIfNoEntry: false })) {
        unlinkSync(pending);
      }
      throw error;
    }
    let released = false;
    return Object.freeze({
      lease,
      release(): void {
        if (released) {
          return;
        }
        withSessionStorageLock(identity, (current) => {
          assertSessionStoragePath(current.storageRoot, path);
          if (lstatSync(path, { throwIfNoEntry: false })) {
            const recorded = readLease(current, path);
            if (
              recorded.ownerToken !== lease.ownerToken ||
              recorded.pid !== process.pid
            ) {
              throw new Error(SESSION_LEASE_INVALID);
            }
            unlinkSync(path);
          }
        });
        released = true;
      },
    });
  });
}

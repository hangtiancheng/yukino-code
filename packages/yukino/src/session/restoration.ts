import { realpath, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { isDeepStrictEqual } from "node:util";

import type { SessionManager } from "@/session/manager.js";
import { SessionConflictError } from "@/session/records.js";

export interface SessionCopyConfirmation {
  readonly sourceSessionId: string;
  readonly sourceCwd: string;
  readonly sourceRevision: number;
  readonly sourceLeafId: string | null;
  readonly destination: string;
}

export interface SessionRestorationOptions {
  destination?: string;
  copy?: boolean | SessionCopyConfirmation;
  signal?: AbortSignal;
}

export interface SessionRestorationInspection {
  readonly sourceSessionId: string;
  readonly sourceCwd: string;
  readonly sourceRevision: number;
  readonly sourceLeafId: string | null;
  readonly sourceMissing: boolean;
  readonly destination?: string;
  readonly copyConfirmation?: SessionCopyConfirmation;
}

export interface PreparedSessionRestoration extends SessionRestorationInspection {
  readonly destination: string;
  readonly copy: boolean;
  assertCurrent(signal?: AbortSignal): Promise<void>;
}

async function existingDirectory(
  path: string,
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  if (typeof path !== "string" || !path || !isAbsolute(path)) {
    throw new Error(
      "Restoration destination must be an explicit absolute directory",
    );
  }
  const canonical = await realpath(path);
  if (!(await stat(canonical)).isDirectory()) {
    throw new Error("Restoration destination must be an existing directory");
  }
  signal?.throwIfAborted();
  return canonical;
}

async function sourceDirectoryMissing(
  cwd: string,
  signal?: AbortSignal,
): Promise<boolean> {
  signal?.throwIfAborted();
  try {
    const canonical = await realpath(cwd);
    if (canonical !== cwd) {
      throw new Error(
        "Session source directory no longer has its canonical identity",
      );
    }
    const directory = (await stat(canonical)).isDirectory();
    signal?.throwIfAborted();
    return !directory;
  } catch (error) {
    signal?.throwIfAborted();
    if (
      error instanceof Error &&
      "code" in error &&
      (error.code === "ENOENT" || error.code === "ENOTDIR")
    ) {
      return true;
    }
    throw error;
  }
}

/** Storage remains inspectable even when its original execution directory is gone. */
export async function inspectSessionRestoration(
  source: SessionManager,
  options: Pick<SessionRestorationOptions, "destination" | "signal"> = {},
): Promise<SessionRestorationInspection> {
  options.signal?.throwIfAborted();
  source.refresh();
  const sourceRevision = source.revision;
  const sourceLeafId = source.leafId;
  const sourceMissing = await sourceDirectoryMissing(
    source.cwd,
    options.signal,
  );
  const destination =
    options.destination === undefined
      ? sourceMissing
        ? undefined
        : source.cwd
      : await existingDirectory(options.destination, options.signal);
  options.signal?.throwIfAborted();
  source.refresh();
  if (source.revision !== sourceRevision) {
    throw new SessionConflictError(sourceRevision, source.revision);
  }
  const identity = {
    sourceSessionId: source.id,
    sourceCwd: source.cwd,
    sourceRevision,
    sourceLeafId,
  };
  return Object.freeze({
    ...identity,
    sourceMissing,
    destination,
    copyConfirmation:
      destination === undefined
        ? undefined
        : Object.freeze({ ...identity, destination }),
  });
}

/** Validates confirmation only; never creates directories, copies storage or activates resources. */
export async function prepareSessionRestoration(
  source: SessionManager,
  currentCwd: string,
  options: SessionRestorationOptions = {},
): Promise<PreparedSessionRestoration> {
  if (
    !options ||
    typeof options !== "object" ||
    Array.isArray(options) ||
    Object.keys(options).some(
      (key) => !["destination", "copy", "signal"].includes(key),
    ) ||
    (options.copy !== undefined &&
      typeof options.copy !== "boolean" &&
      (typeof options.copy !== "object" || options.copy === null)) ||
    (options.signal !== undefined && !(options.signal instanceof AbortSignal))
  ) {
    throw new Error("Invalid session restoration options");
  }
  const requested = { ...options };
  const inspection = await inspectSessionRestoration(source, requested);
  const copy = requested.copy !== undefined && requested.copy !== false;
  if (
    (source.cwd !== currentCwd || copy || inspection.sourceMissing) &&
    requested.destination === undefined
  ) {
    throw new Error(
      "Cross-project restoration or copy requires an explicit destination",
    );
  }
  if (inspection.sourceMissing && !copy) {
    throw new Error(
      "Missing source directory: only an explicit copy to an existing destination is allowed",
    );
  }
  if (!copy && inspection.destination !== source.cwd) {
    throw new Error(
      "Restoring at a different destination requires an explicit copy with a new session identity",
    );
  }
  const destination = inspection.destination;
  if (destination === undefined) {
    throw new Error("Restoration requires an existing destination directory");
  }
  if (
    typeof requested.copy === "object" &&
    !isDeepStrictEqual(requested.copy, inspection.copyConfirmation)
  ) {
    throw new Error(
      "Stale session copy confirmation: inspect the source revision and destination again",
    );
  }
  return Object.freeze({
    ...inspection,
    destination,
    copy,
    async assertCurrent(signal = requested.signal) {
      const current = await inspectSessionRestoration(source, {
        destination: requested.destination,
        signal,
      });
      if (current.sourceRevision !== inspection.sourceRevision) {
        throw new SessionConflictError(
          inspection.sourceRevision,
          current.sourceRevision,
        );
      }
      if (!isDeepStrictEqual(current, inspection)) {
        throw new Error(
          "Session restoration source or destination changed after confirmation",
        );
      }
    },
  });
}

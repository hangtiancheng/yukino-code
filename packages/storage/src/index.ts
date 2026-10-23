import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  ARTIFACTS_DIR_NAME,
  INVALID_SESSION_ID_ERROR,
  PROJECTS_DIR_NAME,
  SESSION_ID_RE,
  SESSIONS_DIR_NAME,
  YUKINO_DIR_NAME,
} from "./constants.js";
import { canonicalPath } from "@yukino.js/utils/paths.js";

export * from "./constants.js";
export * from "./private.js";

export function getYukinoDir(): string {
  return join(homedir(), YUKINO_DIR_NAME);
}

export function yukinoPath(...segments: string[]): string {
  return join(getYukinoDir(), ...segments);
}

export function sessionPath(sessionId: string, ...segments: string[]): string {
  if (!SESSION_ID_RE.test(sessionId)) {
    throw new Error(INVALID_SESSION_ID_ERROR);
  }
  return yukinoPath(
    SESSIONS_DIR_NAME,
    ARTIFACTS_DIR_NAME,
    sessionId,
    ...segments,
  );
}

export function projectKey(cwd: string): string {
  return createHash("sha256").update(canonicalPath(cwd)).digest("hex");
}

export function projectPath(cwd: string, ...segments: string[]): string {
  return yukinoPath(PROJECTS_DIR_NAME, projectKey(cwd), ...segments);
}

export function getSessionsDir(cwd: string): string {
  return yukinoPath(SESSIONS_DIR_NAME, projectKey(cwd));
}

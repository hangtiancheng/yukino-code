import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  ARTIFACTS_DIR_NAME,
  PROJECTS_DIR_NAME,
  SESSIONS_DIR_NAME,
  YUKINO_DIR_NAME,
} from "@/storage/constants.js";
import { canonicalPath } from "@/utils/paths.js";

export * as Constants from "@/storage/constants.js";
export * as Private from "@/storage/private.js";

export function getYukinoDir(): string {
  return join(homedir(), YUKINO_DIR_NAME);
}

export function yukinoPath(...segments: string[]): string {
  return join(getYukinoDir(), ...segments);
}

export function sessionPath(sessionId: string, ...segments: string[]): string {
  if (!/^[A-Za-z0-9_-]+$/u.test(sessionId)) {
    throw new Error("Invalid session ID");
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

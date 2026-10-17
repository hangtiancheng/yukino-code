import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

import { canonicalPath } from "@/utils/paths.js";

export function getYukinoDir(): string {
  return join(homedir(), ".yukino");
}

export function yukinoPath(...segments: string[]): string {
  return join(getYukinoDir(), ...segments);
}

export function sessionPath(sessionId: string, ...segments: string[]): string {
  if (!/^[A-Za-z0-9_-]+$/u.test(sessionId)) {
    throw new Error("Invalid session ID");
  }
  return yukinoPath("sessions", "artifacts", sessionId, ...segments);
}

export function projectKey(cwd: string): string {
  return createHash("sha256").update(canonicalPath(cwd)).digest("hex");
}

export function projectPath(cwd: string, ...segments: string[]): string {
  return yukinoPath("projects", projectKey(cwd), ...segments);
}

export function getSessionsDir(cwd: string): string {
  return yukinoPath("sessions", projectKey(cwd));
}

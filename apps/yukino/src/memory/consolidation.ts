import { existsSync, statSync } from "node:fs";
import { join, basename } from "node:path";

import { Agent } from "@/agent/index.js";
import { ConversationManager } from "@/conversation/index.js";
import type { LLMClient } from "@/llm/client.js";
import { createChildLogger } from "@/logger/index.js";
import {
  CONSOLIDATION_MAX_ITERATIONS,
  DEFAULT_MIN_HOURS,
  DEFAULT_MIN_SESSIONS,
  LOCK_FILE,
  MEMORY_DIR_NAME,
  MEMORY_INDEX_NAME,
  MILLISECONDS_PER_HOUR,
  RUNNING_LOCK_FILE,
  SCAN_THROTTLE_MS,
} from "@/memory/constants.js";
import { MemoryPermissionChecker } from "@/memory/permissions.js";
import { buildConsolidationPrompt } from "@/memory/prompts.js";
import { extractWrittenPaths } from "@/memory/written-paths.js";
import { listSessions } from "@/session/index.js";
import { projectPath, yukinoPath, getSessionsDir } from "@/storage/index.js";
import { writePrivateFileSync as writeFileSync } from "@/storage/private.js";
import { tryAcquireFileSyncLock } from "@/teams/file-lock.js";
import { EditFileTool } from "@/tools/edit-file.js";
import { FileStateCache } from "@/tools/file-state-cache.js";
import { GlobTool } from "@/tools/glob.js";
import { GrepTool } from "@/tools/grep.js";
import { ReadFileTool } from "@/tools/read-file.js";
import { ToolRegistry } from "@/tools/registry.js";
import { WriteFileTool } from "@/tools/write-file.js";

const log = createChildLogger({ module: "memory" });

/**
 * MemoryConsolidator implements background memory consolidation.
 * Once both the time gate (by default >=24h since the last pass) and the
 * session gate (by default >=5 sessions modified since then) are satisfied,
 * it automatically forks a subagent to consolidate memories: merge duplicates,
 * remove stale entries, resolve contradictions, and maintain the index.
 */
export class MemoryConsolidator {
  private client: LLMClient;
  private cwd: string;
  private lastScanAt = 0;
  private minHours: number;
  private minSessions: number;
  private appendSystem?: (msg: string) => void;
  private controller: AbortController | null = null;
  private completion: Promise<unknown> = Promise.resolve();
  private disposed = false;

  constructor(
    client: LLMClient,
    cwd: string,
    opts?: {
      minHours?: number;
      minSessions?: number;
      appendSystem?: (msg: string) => void;
    },
  ) {
    this.client = client;
    this.cwd = cwd;
    this.minHours = opts?.minHours ?? DEFAULT_MIN_HOURS;
    this.minSessions = opts?.minSessions ?? DEFAULT_MIN_SESSIONS;
    this.appendSystem = opts?.appendSystem;
  }

  /**
   * Checks gating conditions and runs a consolidation pass in the background if met.
   * Should be called when each agent loop completes.
   */
  maybeRun(): Promise<void> {
    if (this.disposed) {
      return Promise.resolve();
    }
    const memDir = projectPath(this.cwd, MEMORY_DIR_NAME);
    if (!existsSync(memDir)) {
      return Promise.resolve();
    }

    const lastAt = readLastConsolidatedAt(memDir);
    const hoursSince = (Date.now() - lastAt) / MILLISECONDS_PER_HOUR;
    if (hoursSince < this.minHours) {
      return Promise.resolve();
    }

    const now = Date.now();
    if (now - this.lastScanAt < SCAN_THROTTLE_MS) {
      return Promise.resolve();
    }
    this.lastScanAt = now;

    const sessionIDs = listSessionsSince(this.cwd, lastAt);
    if (sessionIDs.length < this.minSessions) {
      return Promise.resolve();
    }

    const releaseLock = tryAcquireFileSyncLock(join(memDir, RUNNING_LOCK_FILE));
    if (!releaseLock) {
      return Promise.resolve();
    }

    this.completion = this.run(memDir, sessionIDs)
      .then(() => {
        if (!this.disposed) {
          markConsolidationSucceeded(memDir);
        }
      })
      .catch((err: unknown) => {
        log.error({ err }, "memory consolidation failed");
      })
      .finally(releaseLock)
      .catch((err: unknown) => {
        log.error({ err }, "failed to release consolidation lock");
      });
    return Promise.resolve();
  }

  /**
   * Stop any in-flight consolidation and await its settlement. Called on host
   * teardown so a background consolidation cannot outlive its owner; an aborted
   * run rejects, so it is never marked successful.
   */
  async dispose(): Promise<void> {
    this.disposed = true;
    this.controller?.abort();
    await this.completion;
  }

  run(memDir: string, sessionIDs: string[]): Promise<void> {
    if (this.disposed || this.controller) {
      return Promise.reject(
        new Error("Memory consolidator is disposed or already running"),
      );
    }
    const run = this.execute(memDir, sessionIDs).finally(() => {
      this.controller = null;
    });
    this.completion = run.catch(() => undefined);
    return run;
  }

  private async execute(memDir: string, sessionIDs: string[]): Promise<void> {
    const controller = new AbortController();
    this.controller = controller;
    const userMemDir = yukinoPath(MEMORY_DIR_NAME);
    const transcriptDir = getSessionsDir(this.cwd);
    const prompt = buildConsolidationPrompt(
      memDir,
      userMemDir,
      transcriptDir,
      sessionIDs,
    );

    const subRegistry = new ToolRegistry();
    subRegistry.register(new ReadFileTool());
    subRegistry.register(new WriteFileTool());
    subRegistry.register(new EditFileTool());
    subRegistry.register(new GlobTool());
    subRegistry.register(new GrepTool());
    const subChecker = new MemoryPermissionChecker(this.cwd, true);

    const conv = new ConversationManager();
    conv.addUserMessage(prompt);

    const subagent = new Agent({
      client: this.client,
      registry: subRegistry,
      checker: subChecker,
      conversation: conv,
      cwd: this.cwd,
      fileStateCache: new FileStateCache(),
      maxIterations: CONSOLIDATION_MAX_ITERATIONS,
      abortSignal: controller.signal,
    });

    for await (const event of subagent.run()) {
      if (event.type === "error") {
        throw event.error;
      }
    }
    controller.signal.throwIfAborted();

    const writtenPaths = extractWrittenPaths(conv.getMessages());
    const memoryPaths = writtenPaths.filter(
      (p) => basename(p) !== MEMORY_INDEX_NAME,
    );

    if (memoryPaths.length > 0 && this.appendSystem) {
      const names = memoryPaths.map((p) => basename(p));
      this.appendSystem(`Memory improved: ${names.join(", ")}`);
    }
  }
}

function lockPath(memDir: string): string {
  return join(memDir, LOCK_FILE);
}

function readLastConsolidatedAt(memDir: string): number {
  const path = lockPath(memDir);
  if (!existsSync(path)) {
    return 0;
  }
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

function markConsolidationSucceeded(memDir: string): void {
  try {
    writeFileSync(lockPath(memDir), "");
  } catch (err) {
    log.error({ err }, "failed to update consolidation timestamp");
  }
}

function listSessionsSince(cwd: string, sinceMs: number): string[] {
  const sessions = listSessions(cwd);
  const since = new Date(sinceMs);
  return sessions.filter((s) => s.modTime > since).map((s) => s.id);
}

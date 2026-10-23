import { readdirSync, existsSync, renameSync, rmSync } from "node:fs";
import { join, basename } from "node:path";

import yaml from "js-yaml";

import { Agent } from "@yukino.js/agent";
import { ConversationManager } from "@yukino.js/conversation";
import type { LLMClient } from "@yukino.js/llm/client.js";
import { createChildLogger } from "@yukino.js/logger";
import {
  DEFAULT_MEMORY_TYPE,
  EXTRACTION_MAX_ITERATIONS,
  FRONTMATTER_DESCRIPTION_RE,
  FRONTMATTER_TYPE_RE,
  MEMORY_BODY_RE,
  MEMORY_DESC_RE,
  MEMORY_DIR_NAME,
  MEMORY_INDEX_NAME,
  MEMORY_NAME_PATTERN,
  MEMORY_NAME_RE,
  MEMORY_TYPE_RE,
  NONE_SENTINEL,
  TEXT_BLOCK_SEPARATOR_RE,
} from "./constants.js";
import { MemoryManager } from "./manager.js";
import { MemoryPermissionChecker } from "./permissions.js";
import { buildExtractionPrompt } from "./prompts.js";
import { extractWrittenPaths } from "./written-paths.js";
import { projectPath, yukinoPath } from "@yukino.js/storage";
import {
  readPrivateFileSync as readFileSync,
  mkdirPrivateSync as mkdirSync,
  writePrivateFileSync as writeFileSync,
} from "@yukino.js/storage/private.js";
import { withFileSyncLock } from "@yukino.js/teams/file-lock.js";
import { EditFileTool } from "@yukino.js/tools/edit-file.js";
import { FileStateCache } from "@yukino.js/tools/file-state-cache.js";
import { GlobTool } from "@yukino.js/tools/glob.js";
import { GrepTool } from "@yukino.js/tools/grep.js";
import { ReadFileTool } from "@yukino.js/tools/read-file.js";
import { ToolRegistry } from "@yukino.js/tools/registry.js";
import { WriteFileTool } from "@yukino.js/tools/write-file.js";
import { asErrorString } from "@yukino.js/utils";

const log = createChildLogger({ module: "memory" });

/** A memory block parsed from LLM streamed text (MEMORY_NAME/MEMORY_TYPE/MEMORY_DESC/MEMORY_BODY). */
interface ParsedTextMemory {
  name: string;
  type: string;
  description: string;
  body: string;
}

/**
 * MemoryExtractor implements the background memory-extraction subagent.
 * - Uses a child agent + tools (ReadFile/WriteFile/EditFile/Glob/Grep) instead of bare LLM calls
 * - Sends existing memory manifest to the LLM before extraction for deduplication
 * - inProgress + pendingContext coalescing: at most one extraction is queued,
 *   and only the latest queued summary runs
 * - When the child agent writes no memory files via tools, falls back to
 *   parsing streamed text blocks (MEMORY_NAME/...) and writing them to disk
 */
export class MemoryExtractor {
  private client: LLMClient;
  private cwd: string;
  private inProgress = false;
  private pendingContext: string | null = null;
  private controller: AbortController | null = null;
  private completion: Promise<unknown> = Promise.resolve();
  private disposed = false;

  constructor(client: LLMClient, cwd: string) {
    this.client = client;
    this.cwd = cwd;
  }

  async extract(conversationSummary: string): Promise<string[]> {
    if (this.disposed) {
      return [];
    }
    if (this.inProgress) {
      this.pendingContext = conversationSummary;
      return [];
    }
    const run = this.runExtraction(conversationSummary);
    this.completion = run.catch(() => undefined);
    return run;
  }

  /**
   * Stop any in-flight extraction and await its settlement. Called on host
   * teardown (exit / dispose / session abandon) so a background memory task
   * cannot outlive its owner, keep hitting the model, or write after shutdown.
   */
  async dispose(): Promise<void> {
    this.disposed = true;
    this.pendingContext = null;
    this.controller?.abort();
    await this.completion;
  }

  private async runExtraction(conversationSummary: string): Promise<string[]> {
    this.inProgress = true;
    const controller = new AbortController();
    this.controller = controller;
    let result: string[] = [];
    let failure: unknown;

    try {
      result = await this.doExtract(conversationSummary, controller.signal);
    } catch (err) {
      failure = err;
    } finally {
      this.inProgress = false;
      this.controller = null;
      const pending = this.pendingContext;
      this.pendingContext = null;
      if (pending !== null && !this.disposed) {
        try {
          const trailingResult = await this.runExtraction(pending);
          result = [...result, ...trailingResult];
        } catch (err) {
          failure ??= err;
        }
      }
    }

    if (failure !== undefined) {
      throw failure instanceof Error
        ? failure
        : new Error(asErrorString(failure));
    }
    return result;
  }

  /** Scan existing memory files and build a manifest for LLM deduplication */
  private scanExistingMemories(): string {
    const dirs = [
      projectPath(this.cwd, MEMORY_DIR_NAME),
      yukinoPath(MEMORY_DIR_NAME),
    ];
    const entries: string[] = [];

    const checker = new MemoryPermissionChecker(this.cwd);
    for (const dir of dirs) {
      if (
        checker.check("Glob", "read", { path: dir, pattern: "*.md" }).effect !==
          "allow" ||
        !existsSync(dir)
      ) {
        continue;
      }
      try {
        const files = readdirSync(dir).filter(
          (f) => f.endsWith(".md") && f !== MEMORY_INDEX_NAME,
        );
        for (const file of files) {
          try {
            if (
              checker.check("ReadFile", "read", { file_path: join(dir, file) })
                .effect !== "allow"
            ) {
              continue;
            }
            const content = readFileSync(join(dir, file), "utf-8");
            const typeMatch = FRONTMATTER_TYPE_RE.exec(content);
            const descMatch = FRONTMATTER_DESCRIPTION_RE.exec(content);
            const type = typeMatch?.[1]?.trim() ?? DEFAULT_MEMORY_TYPE;
            const desc = descMatch?.[1]?.trim() ?? "";
            entries.push(`- [${type}] ${file}: ${desc}`);
          } catch {
            /** noop */
          }
        }
      } catch {
        /** noop */
      }
    }

    return entries.length > 0 ? entries.join("\n") : "";
  }

  private async doExtract(
    conversationSummary: string,
    abortSignal: AbortSignal,
  ): Promise<string[]> {
    const extractionPrompt = buildExtractionPrompt(
      conversationSummary,
      this.scanExistingMemories(),
      yukinoPath(MEMORY_DIR_NAME),
      projectPath(this.cwd, MEMORY_DIR_NAME),
    );

    const subRegistry = new ToolRegistry();
    subRegistry.register(new ReadFileTool());
    subRegistry.register(new WriteFileTool());
    subRegistry.register(new EditFileTool());
    subRegistry.register(new GlobTool());
    subRegistry.register(new GrepTool());

    const subChecker = new MemoryPermissionChecker(this.cwd);

    const forkedConv = new ConversationManager();
    forkedConv.addUserMessage(extractionPrompt);

    const subagent = new Agent({
      client: this.client,
      registry: subRegistry,
      checker: subChecker,
      conversation: forkedConv,
      cwd: this.cwd,
      fileStateCache: new FileStateCache(),
      maxIterations: EXTRACTION_MAX_ITERATIONS,
      abortSignal,
    });

    // Drive the child agent to completion without propagating events to the UI;
    // concurrently collect streamed text as a fallback parse source in case no
    // memory files are written via tools (i.e., the model emits structured text
    // blocks directly).
    let streamedText = "";
    for await (const event of subagent.run()) {
      if (event.type === "error") {
        throw event.error;
      }
      if (event.type === "stream_text") {
        streamedText += event.text;
      }
    }
    abortSignal.throwIfAborted();

    // Fast path: LLM wrote memory files directly using WriteFile/EditFile tools
    const writtenPaths = extractWrittenPaths(forkedConv.getMessages());
    const memoryPaths = writtenPaths.filter(
      (p) => basename(p) !== MEMORY_INDEX_NAME,
    );

    let saved: string[];
    if (memoryPaths.length > 0) {
      saved = memoryPaths.map((p) => basename(p, ".md"));
    } else {
      // Fallback path: LLM emitted MEMORY_NAME/... text blocks directly; parse locally and persist
      saved = this.persistTextMemories(streamedText);
    }

    if (saved.length > 0) {
      const mgr = new MemoryManager(this.cwd, subChecker);
      mgr.rebuildIndex();
    }

    return saved;
  }

  /**
   * Text protocol fallback: when the sub-agent wrote no memory files via tools
   * and instead emitted structured text blocks (MEMORY_NAME/MEMORY_TYPE/MEMORY_DESC/MEMORY_BODY,
   * separated by a standalone `---` line), parse them locally and persist by type.
   * Returns the list of written memory names (without extensions).
   */
  private persistTextMemories(text: string): string[] {
    const memories = this.parseTextMemoryBlocks(text);
    if (memories.length === 0) {
      return [];
    }

    const saved: string[] = [];
    for (const mem of memories) {
      const dir = this.dirForMemoryType(mem.type);
      const filePath = join(dir, `${mem.name}.md`);
      if (
        new MemoryPermissionChecker(this.cwd).check("WriteFile", "write", {
          file_path: filePath,
        }).effect !== "allow"
      ) {
        continue;
      }
      const content = this.formatMemoryFile(mem);
      try {
        mkdirSync(dir, { recursive: true });
        // Serialize against concurrent extractors and write atomically (private
        // temp file + rename) so a crash mid-write never leaves a partial file
        // and two extractions never mix. Only a successful write is reported as
        // saved (and thus indexed).
        withFileSyncLock(filePath, () => {
          if (existsSync(filePath)) {
            // An existing same-name topic is read, then explicitly rejected
            // rather than silently overwritten or merged (which would mix
            // content).
            if (
              new MemoryPermissionChecker(this.cwd).check("ReadFile", "read", {
                file_path: filePath,
              }).effect !== "allow"
            ) {
              return;
            }
            const existing = readFileSync(filePath, "utf-8");
            if (existing !== content) {
              log.warn(
                { filePath },
                "memory text fallback: refusing to overwrite an existing memory file",
              );
            }
            return;
          }
          const tmp = `${filePath}.${String(process.pid)}.mem-tmp`;
          try {
            // "wx" refuses to create over an existing path (including a
            // symlink), so the temp file cannot be redirected elsewhere.
            writeFileSync(tmp, content, { encoding: "utf-8", flag: "wx" });
            renameSync(tmp, filePath);
          } finally {
            rmSync(tmp, { force: true });
          }
          saved.push(mem.name);
        });
      } catch (err) {
        log.error({ err }, "memory text fallback write failed");
      }
    }
    return saved;
  }

  /** Parse structured text blocks; returns empty array for NONE or empty text. */
  private parseTextMemoryBlocks(text: string): ParsedTextMemory[] {
    const trimmed = text.trim();
    if (trimmed === "" || trimmed === NONE_SENTINEL) {
      return [];
    }

    const memories: ParsedTextMemory[] = [];
    const blocks = trimmed.split(TEXT_BLOCK_SEPARATOR_RE);
    for (const block of blocks) {
      const mem = this.parseTextMemoryBlock(block);
      if (mem) {
        memories.push(mem);
      }
    }
    return memories;
  }

  /** Parse a single block; MEMORY_BODY supports multi-line. Returns null for blocks with a missing or invalid MEMORY_NAME, or an empty body. */
  private parseTextMemoryBlock(block: string): ParsedTextMemory | null {
    const lines = block.split("\n");
    const mem: ParsedTextMemory = {
      name: "",
      type: "",
      description: "",
      body: "",
    };
    const bodyLines: string[] = [];
    let inBody = false;

    for (const line of lines) {
      const nameMatch = MEMORY_NAME_RE.exec(line);
      const typeMatch = MEMORY_TYPE_RE.exec(line);
      const descMatch = MEMORY_DESC_RE.exec(line);
      const bodyMatch = MEMORY_BODY_RE.exec(line);

      if (nameMatch) {
        if (mem.name) {
          // Malformed block carrying a second record: reset the accumulated
          // fields instead of merging them across the two records.
          mem.type = "";
          mem.description = "";
          mem.body = "";
          bodyLines.length = 0;
        }
        mem.name = nameMatch[1].trim();
        inBody = false;
      } else if (typeMatch) {
        mem.type = typeMatch[1].trim();
        inBody = false;
      } else if (descMatch) {
        mem.description = descMatch[1].trim();
        inBody = false;
      } else if (bodyMatch) {
        if (mem.body !== "" || bodyLines.length > 0) {
          // A second MEMORY_BODY starts a new body: the previous body's
          // continuation lines belong to it, not to this one.
          bodyLines.length = 0;
        }
        mem.body = bodyMatch[1];
        inBody = true;
      } else if (inBody) {
        bodyLines.push(line);
      }
    }

    mem.body = (mem.body ? [mem.body, ...bodyLines] : bodyLines)
      .join("\n")
      .trimEnd();

    if (!MEMORY_NAME_PATTERN.test(mem.name) || !mem.body.trim()) {
      return null;
    }
    if (!mem.type) {
      // Default to project-level reference when no type is given
      mem.type = DEFAULT_MEMORY_TYPE;
    }
    return mem;
  }

  /** Route to the appropriate directory by type: user/feedback -> user-level; otherwise -> project-level */
  private dirForMemoryType(type: string): string {
    const t = type.toLowerCase();
    if (t === "user" || t === "feedback") {
      return yukinoPath(MEMORY_DIR_NAME);
    }
    return projectPath(this.cwd, MEMORY_DIR_NAME);
  }

  /** Format a memory file: frontmatter (name/description/type) + body */
  private formatMemoryFile(mem: ParsedTextMemory): string {
    const frontmatter = yaml.dump(
      { name: mem.name, description: mem.description, type: mem.type },
      { forceQuotes: true, lineWidth: -1, noRefs: true, quotingType: '"' },
    );
    return `---\n${frontmatter}---\n\n${mem.body}\n`;
  }
}

import { isUtf8 } from "node:buffer";
import { lstatSync, statSync, type Stats } from "node:fs";
import { lstat, mkdir, readFile, stat, unlink } from "node:fs/promises";
import { dirname } from "node:path";

import { applyPatch } from "diff";
import { z } from "zod";

import {
  isPrivateStatePath,
  protectPrivateFileSync,
} from "@/storage/private.js";
import { writeFileAtomically } from "@/tools/atomic-write.js";
import {
  APPLY_PATCH_PATH_CHANGED_ERROR,
  OPERATION_INTERRUPTED_ERROR,
} from "@/tools/constants.js";
import { buildDiff } from "@/tools/diff.js";
import {
  checkExecutionPermission,
  withWorkspaceMutation,
} from "@/tools/execution-coordinator.js";
import { withFileMutationQueues } from "@/tools/file-mutation-queue.js";
import { parseFilePatches, type FilePatch } from "@/tools/patch.js";
import {
  APPLY_PATCH_DESCRIPTION,
  APPLY_PATCH_PATCH_DESCRIPTION,
} from "@/tools/prompts.js";
import type { ToolCategory, ToolContext, ToolResult } from "@/tools/types.js";
import { ValidatedTool } from "@/tools/validated-tool.js";
import { asErrorString } from "@/utils/index.js";
import { canonicalPath, resolveToolPath } from "@/utils/paths.js";
import { isRecord } from "@/utils/record.js";

interface PatchFileState {
  path: string;
  canonical: string;
  metadata?: Stats;
  content: string;
}

interface PlannedChange {
  hunk: FilePatch;
  source: PatchFileState;
  destination?: PatchFileState;
  content: string;
}

interface CommittedChange {
  kind: "A" | "M" | "D";
  path: string;
  movePath?: string;
  before: string;
  after: string;
}

function formatChanges(changes: readonly CommittedChange[]): string {
  const summary = changes
    .map(
      (change) =>
        `${change.kind} ${change.path}${change.movePath ? ` → ${change.movePath}` : ""}`,
    )
    .join("\n");
  const diffs = changes
    .map((change) => {
      const diff = buildDiff(
        change.before.replace(/\r\n|\r/gu, "\n"),
        change.after.replace(/\r\n|\r/gu, "\n"),
      );
      return diff.text ? `${change.movePath ?? change.path}\n${diff.text}` : "";
    })
    .filter(Boolean)
    .join("\n\n");
  return `${summary}${diffs ? `\n\n${diffs}` : ""}`;
}

function checkState(ctx: ToolContext, state: PatchFileState): void {
  ctx.abortSignal?.throwIfAborted();
  const entry = lstatSync(state.path, { throwIfNoEntry: false });
  const actual = entry?.isSymbolicLink()
    ? statSync(state.path, { throwIfNoEntry: false })
    : entry;
  const expected = state.metadata;
  if (
    canonicalPath(state.path) !== state.canonical ||
    Boolean(entry) !== Boolean(expected) ||
    (expected &&
      (actual?.dev !== expected.dev ||
        actual.ino !== expected.ino ||
        actual.size !== expected.size ||
        actual.mtimeMs !== expected.mtimeMs ||
        actual.ctimeMs !== expected.ctimeMs))
  ) {
    throw new Error(APPLY_PATCH_PATH_CHANGED_ERROR);
  }
  if (
    ctx.fileStateCache &&
    (state.metadata || ctx.fileStateCache.has(state.path))
  ) {
    const gate = ctx.fileStateCache.check(state.path);
    if (!gate.ok) {
      throw new Error(`${state.path}: ${gate.error}`);
    }
  }
}

async function readState(
  ctx: ToolContext,
  path: string,
  canonical: string,
  requireExisting: boolean,
  requireRegularEntry: boolean,
): Promise<PatchFileState> {
  ctx.abortSignal?.throwIfAborted();
  const entry = await lstat(path).catch((error: unknown) => {
    if (!isRecord(error) || error.code !== "ENOENT") {
      throw error;
    }
    return undefined;
  });
  if (requireExisting && !entry) {
    throw new Error(`File does not exist: ${path}`);
  }
  if (requireRegularEntry && entry?.isSymbolicLink()) {
    throw new Error(
      `Delete and move sources cannot be symbolic links: ${path}`,
    );
  }
  const privateState = entry && isPrivateStatePath(path);
  if (privateState) {
    protectPrivateFileSync(path);
  }
  const metadata =
    privateState || entry?.isSymbolicLink() ? await stat(path) : entry;
  if (metadata && !metadata.isFile()) {
    throw new Error(`Patch targets must be regular files: ${path}`);
  }
  const state: PatchFileState = {
    path,
    canonical,
    metadata,
    content: "",
  };
  checkState(ctx, state);
  if (entry) {
    const bytes = await readFile(path, { signal: ctx.abortSignal });
    if (!isUtf8(bytes)) {
      throw new Error(`Patch requires UTF-8 text files: ${path}`);
    }
    state.content = bytes.toString("utf8");
    checkState(ctx, state);
  }
  return state;
}

const ApplyPatchInputSchema = z.strictObject({
  patch: z.string().min(1).describe(APPLY_PATCH_PATCH_DESCRIPTION),
});

export class ApplyPatchTool extends ValidatedTool<
  z.output<typeof ApplyPatchInputSchema>
> {
  name = "ApplyPatch";
  description = APPLY_PATCH_DESCRIPTION;
  category: ToolCategory = "write";

  parameters() {
    return ApplyPatchInputSchema;
  }

  protected async executeValidated(
    ctx: ToolContext,
    args: z.output<typeof ApplyPatchInputSchema>,
  ): Promise<ToolResult> {
    const patch = args.patch;
    const committed: CommittedChange[] = [];
    try {
      return await withWorkspaceMutation(ctx, this.name, args, () =>
        this.executeMutation(ctx, args, patch, committed),
      );
    } catch (error) {
      const message = ctx.abortSignal?.aborted
        ? OPERATION_INTERRUPTED_ERROR
        : `Error: ${asErrorString(error)}`;
      return {
        output: `${message}${committed.length ? `\nChanges already committed:\n${formatChanges(committed)}` : ""}`,
        isError: true,
        structuredContent: {
          fileOperations: {
            readFiles: [],
            modifiedFiles: committed.flatMap((change) => [
              change.path,
              ...(change.movePath ? [change.movePath] : []),
            ]),
          },
        },
      };
    }
  }

  private async executeMutation(
    ctx: ToolContext,
    args: Record<string, unknown>,
    patch: string,
    committed: CommittedChange[],
  ): Promise<ToolResult> {
    const hunks = parseFilePatches(patch);
    const paths = hunks.flatMap((hunk) => [
      resolveToolPath(ctx.cwd, hunk.path),
      ...(hunk.type === "update" && hunk.movePath
        ? [resolveToolPath(ctx.cwd, hunk.movePath)]
        : []),
    ]);
    const canonical = paths.map((path) => canonicalPath(path));
    const targets = new Set<string>();
    for (const [index, target] of canonical.entries()) {
      if (targets.has(target)) {
        throw new Error(
          `Multiple patch operations target the same file: ${paths[index]}`,
        );
      }
      targets.add(target);
    }
    return withFileMutationQueues(canonical, async () => {
      ctx.abortSignal?.throwIfAborted();
      if (
        paths.some((path, index) => canonicalPath(path) !== canonical[index])
      ) {
        throw new Error(APPLY_PATCH_PATH_CHANGED_ERROR);
      }
      const blocked = checkExecutionPermission(ctx, this.name, args);
      if (blocked) {
        return blocked;
      }
      const planned: PlannedChange[] = [];
      let pathIndex = 0;
      for (const hunk of hunks) {
        const source = await readState(
          ctx,
          paths[pathIndex],
          canonical[pathIndex],
          hunk.type !== "add",
          hunk.type === "delete" ||
            (hunk.type === "update" && Boolean(hunk.movePath)),
        );
        pathIndex++;
        const destination =
          hunk.type === "update" && hunk.movePath
            ? await readState(
                ctx,
                paths[pathIndex],
                canonical[pathIndex++],
                false,
                false,
              )
            : undefined;
        if (hunk.type === "add" && source.metadata) {
          throw new Error(`File already exists: ${source.path}`);
        }
        const content = applyPatch(source.content, hunk.patch, {
          fuzzFactor: 0,
        });
        if (content === false || (hunk.type === "delete" && content !== "")) {
          throw new Error(`Patch does not match ${source.path}`);
        }
        planned.push({ hunk, source, destination, content });
      }
      for (const change of planned) {
        checkState(ctx, change.source);
        if (change.destination) {
          checkState(ctx, change.destination);
        }
      }
      for (const change of planned) {
        const permission = checkExecutionPermission(ctx, this.name, args);
        if (permission) {
          throw new Error(permission.output);
        }
        const { source, destination, hunk, content } = change;
        checkState(ctx, source);
        if (hunk.type === "delete") {
          ctx.fileHistory?.trackEdit(source.path);
          checkState(ctx, source);
          await unlink(source.path);
          ctx.fileStateCache?.delete(source.path);
          committed.push({
            kind: "D",
            path: source.path,
            before: source.content,
            after: "",
          });
          continue;
        }
        const target = destination ?? source;
        checkState(ctx, target);
        await mkdir(dirname(target.path), { recursive: true });
        checkState(ctx, source);
        checkState(ctx, target);
        const writePermission = checkExecutionPermission(ctx, this.name, args);
        if (writePermission) {
          throw new Error(writePermission.output);
        }
        ctx.fileHistory?.trackEdit(source.path);
        if (destination) {
          ctx.fileHistory?.trackEdit(destination.path);
        }
        checkState(ctx, source);
        if (destination) {
          checkState(ctx, destination);
        }
        await writeFileAtomically(target.path, content, ctx.abortSignal);
        ctx.fileStateCache?.update(target.path);
        committed.push({
          kind: target.metadata ? "M" : "A",
          path: target.path,
          before: target.content,
          after: content,
        });
        if (destination) {
          checkState(ctx, source);
          const removePermission = checkExecutionPermission(
            ctx,
            this.name,
            args,
          );
          if (removePermission) {
            throw new Error(removePermission.output);
          }
          await unlink(source.path);
          ctx.fileStateCache?.delete(source.path);
          committed[committed.length - 1] = {
            kind: "M",
            path: source.path,
            movePath: destination.path,
            before: source.content,
            after: content,
          };
        }
      }
      return {
        structuredContent: {
          fileOperations: {
            readFiles: [],
            modifiedFiles: committed.flatMap((change) => [
              change.path,
              ...(change.movePath ? [change.movePath] : []),
            ]),
          },
        },
        output: `Success. Updated the following files:\n${formatChanges(committed)}`,
        isError: false,
      };
    });
  }
}

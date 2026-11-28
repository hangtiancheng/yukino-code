import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { requestToolPermission } from "@/permissions/request.js";
import type { ProjectTrustRequest, TrustDecision } from "@/project/types.js";
import type { AgentRuntime } from "@/runtime/types.js";
import {
  generateBranchSummary,
  prepareBranchSummary,
} from "@/session/branch-summary.js";
import type { SESSION_TREE_FILTERS } from "@/session/constants.js";
import {
  ARTIFACT_ID_RE,
  BRANCH_SUMMARY_MAX_DESCRIPTION_CHARS,
  BRANCH_SUMMARY,
  COMPACT_BOUNDARY,
  MAX_METADATA_TEXT,
  LOCAL_DIAGNOSTICS_USAGE,
  SESSION_RUNTIME_STATE,
  SESSION_RUNTIME_STATE_LABEL,
  SESSION_SEARCH_WHITESPACE_RE,
  SESSION_TREE_COMMAND_MAX_CHARS,
  SESSION_TREE_COMMAND_TOO_LONG,
  SESSION_TREE_FOLD_USAGE,
  SESSION_TREE_GO_USAGE,
  SESSION_TREE_INVALID_ROLE,
  SESSION_TREE_LABEL_USAGE,
  SESSION_TREE_ROLE_PREFIX,
  SESSION_TREE_ROLES,
  SESSION_TREE_SHOW_USAGE,
  SESSION_TREE_TOOL_MESSAGE,
  UNKNOWN_SESSION_ENTRY,
} from "@/session/constants.js";
import { SessionManager } from "@/session/manager.js";
import {
  normalizeSessionSearchText,
  sessionSearchTerms,
  setSessionTags,
  previewSessionNameSuggestion,
  applySessionNameSuggestion,
} from "@/session/organization.js";
import type { SessionTreeNode } from "@/session/records.js";
import { projectRuntimeDiagnostics } from "@/session/transfer.js";
import type { Asker } from "@/tools/ask-user.js";
import type { PermissionRequestHandler } from "@/tools/types.js";
import { contentToText } from "@/utils/index.js";

export async function requestProjectTrust(
  ask: Asker,
  request: ProjectTrustRequest,
): Promise<TrustDecision> {
  const counts = new Map<string, number>();
  for (const entry of request.manifest) {
    counts.set(entry.kind, (counts.get(entry.kind) ?? 0) + 1);
  }
  const question = `Trust project resources in ${request.cwd}?\n${[...counts].map(([kind, count]) => `${kind}: ${String(count)}`).join(" · ")}`;
  const answers = await ask([
    {
      question,
      multiSelect: false,
      options: [
        {
          label: "once",
          description: "Trust this manifest for this invocation",
        },
        {
          label: "persistent",
          description: "Remember approval for this exact manifest",
        },
        { label: "deny", description: "Skip project resources" },
      ],
    },
  ]);
  const answer = answers[question];
  return answer === "once" || answer === "persistent" ? answer : "deny";
}

export interface SessionTreeOptions {
  filter?: (typeof SESSION_TREE_FILTERS)[number];
  foldedEntryIds?: readonly string[];
  labeledOnly?: boolean;
}

export interface SessionTreeCommand {
  action: "show" | "go" | "label" | "fold" | "unfold";
  entryId?: string;
  all?: boolean;
  text: string;
  summary?: string;
  options?: SessionTreeOptions;
}

function treeSearchTerms(query: string): string[] {
  const terms = sessionSearchTerms(query);
  if (
    terms.some(
      (term) =>
        term.startsWith(SESSION_TREE_ROLE_PREFIX) &&
        !SESSION_TREE_ROLES.has(term.slice(SESSION_TREE_ROLE_PREFIX.length)),
    )
  ) {
    throw new Error(SESSION_TREE_INVALID_ROLE);
  }
  return terms;
}

export function parseSessionTreeCommand(args: string): SessionTreeCommand {
  if (args.length > SESSION_TREE_COMMAND_MAX_CHARS) {
    throw new Error(SESSION_TREE_COMMAND_TOO_LONG);
  }
  const parts = args.trim().split(SESSION_SEARCH_WHITESPACE_RE).filter(Boolean);
  const [action, entryId, ...rest] = parts;
  if (action === "label") {
    const text = rest.join(" ");
    if (
      !entryId ||
      entryId.startsWith("--") ||
      !ARTIFACT_ID_RE.test(entryId) ||
      text.length > MAX_METADATA_TEXT
    ) {
      throw new Error(SESSION_TREE_LABEL_USAGE);
    }
    return { action, entryId, text };
  }
  if (action === "go") {
    const summary = rest.slice(1).join(" ");
    if (
      !entryId ||
      entryId.startsWith("--") ||
      !ARTIFACT_ID_RE.test(entryId) ||
      (rest.length && rest[0] !== "--summary") ||
      summary.length > BRANCH_SUMMARY_MAX_DESCRIPTION_CHARS
    ) {
      throw new Error(SESSION_TREE_GO_USAGE);
    }
    return { action, entryId, text: "", ...(rest.length ? { summary } : {}) };
  }
  if (action === "fold" || action === "unfold") {
    if (
      !entryId ||
      rest.length ||
      (entryId !== "--all" &&
        (entryId.startsWith("--") || !ARTIFACT_ID_RE.test(entryId)))
    ) {
      throw new Error(SESSION_TREE_FOLD_USAGE);
    }
    return {
      action,
      text: "",
      ...(entryId === "--all" ? { all: true } : { entryId }),
    };
  }
  const command: SessionTreeCommand = { action: "show", text: "" };
  const query: string[] = [];
  const display = action === "show" ? parts.slice(1) : parts;
  for (let index = 0; index < display.length; index++) {
    const part = display[index];
    if (part === "--") {
      query.push(...display.slice(index + 1));
      break;
    }
    if (part === "--summary") {
      command.summary = display.slice(index + 1).join(" ");
      if (command.summary.length > BRANCH_SUMMARY_MAX_DESCRIPTION_CHARS) {
        throw new Error(SESSION_TREE_SHOW_USAGE);
      }
      break;
    }
    if (part === "--labeled-only" || part === "--all-labels") {
      if (command.options) {
        throw new Error(SESSION_TREE_SHOW_USAGE);
      }
      command.options = { labeledOnly: part === "--labeled-only" };
    } else if (part.startsWith("--")) {
      throw new Error(SESSION_TREE_SHOW_USAGE);
    } else {
      query.push(part);
    }
  }
  command.text = query.join(" ");
  treeSearchTerms(command.text);
  return command;
}

function flattenSessionTree(tree: SessionTreeNode[]) {
  const entries: {
    node: SessionTreeNode;
    depth: number;
    parentId: string | null;
  }[] = [];
  const stack: typeof entries = tree
    .map((node) => ({ node, depth: 0, parentId: null }))
    .reverse();
  while (stack.length) {
    const item = stack.pop();
    if (!item) {
      break;
    }
    entries.push(item);
    for (let index = item.node.children.length - 1; index >= 0; index--) {
      stack.push({
        node: item.node.children[index],
        depth: item.depth + 1,
        parentId: item.node.entry.entryId,
      });
    }
  }
  return entries;
}

export function updateSessionTreeOptions(
  tree: SessionTreeNode[],
  options: SessionTreeOptions,
  command: SessionTreeCommand,
): SessionTreeOptions {
  if (command.action === "show") {
    return { ...options, ...command.options };
  }
  if (command.action !== "fold" && command.action !== "unfold") {
    throw new Error(SESSION_TREE_FOLD_USAGE);
  }
  const entries = flattenSessionTree(tree);
  if (
    !command.all &&
    !entries.some(({ node }) => node.entry.entryId === command.entryId)
  ) {
    throw new Error(UNKNOWN_SESSION_ENTRY);
  }
  const folded = new Set(options.foldedEntryIds ?? []);
  const targets = command.all
    ? entries.map(({ node }) => node)
    : entries
        .filter(({ node }) => node.entry.entryId === command.entryId)
        .map(({ node }) => node);
  if (command.action === "unfold" && command.all) {
    folded.clear();
  }
  for (const node of targets) {
    if (command.action === "fold" && node.children.length) {
      folded.add(node.entry.entryId);
    } else {
      folded.delete(node.entry.entryId);
    }
  }
  return { ...options, foldedEntryIds: [...folded] };
}

export async function navigateSessionTree(
  runtime: AgentRuntime,
  manager: SessionManager,
  entryId: string,
  summary?: string,
  signal?: AbortSignal,
): Promise<{ input?: string }> {
  manager.refresh();
  if (summary === undefined) {
    return manager.navigate(entryId);
  }
  const plan = prepareBranchSummary(manager, entryId);
  const ledger = runtime.executionContext?.ledger;
  if (!ledger) {
    throw new Error("Branch summary requires an initialized execution ledger.");
  }
  const payload = await generateBranchSummary(plan, runtime.client, {
    ledger,
    description: summary,
    signal,
  });
  signal?.throwIfAborted();
  manager.refresh();
  if (manager.revision !== plan.revision) {
    throw new Error(
      "Session changed while generating the branch summary. Reopen /tree.",
    );
  }
  if (payload) {
    manager.appendBranchSummary(plan.navigation.leafId, payload);
  } else {
    manager.selectActiveLeaf(plan.navigation.leafId);
  }
  return plan.navigation.input === undefined
    ? {}
    : { input: plan.navigation.input };
}

export interface SessionTreeRow {
  id: string;
  label: string;
  detail: string;
  current: boolean;
  onCurrentPath: boolean;
  depth: number;
  folded: boolean;
  hasChildren: boolean;
}

export function sessionTreeRows(
  tree: SessionTreeNode[],
  leafId: string | null,
  query = "",
  options: SessionTreeOptions = {},
): SessionTreeRow[] {
  const terms = sessionSearchTerms(query);
  const entries = flattenSessionTree(tree);
  const parents = new Map(
    entries.map(({ node, parentId }) => [node.entry.entryId, parentId]),
  );
  const currentPath = new Set<string>();
  let ancestor = leafId;
  while (
    ancestor !== null &&
    parents.has(ancestor) &&
    !currentPath.has(ancestor)
  ) {
    currentPath.add(ancestor);
    ancestor = parents.get(ancestor) ?? null;
  }
  const folded = new Set(options.foldedEntryIds ?? []);
  const hidden = new Set<string>();
  const rows: SessionTreeRow[] = [];
  for (const { node, depth, parentId } of entries) {
    const id = node.entry.entryId;
    const onCurrentPath = currentPath.has(id);
    if (parentId !== null && (folded.has(parentId) || hidden.has(parentId))) {
      hidden.add(id);
    }
    if (
      (!terms.length && hidden.has(id) && !onCurrentPath) ||
      (options.labeledOnly && !node.label?.trim() && !onCurrentPath)
    ) {
      continue;
    }
    const message = node.entry.message;
    const filter = options.filter ?? "all";
    if (
      (filter === "no-tools" &&
        ((!!message.type &&
          message.type !== COMPACT_BOUNDARY &&
          message.type !== BRANCH_SUMMARY) ||
          !!message.tool_results?.length ||
          (!!message.tool_uses?.length &&
            !contentToText(message.content).trim()))) ||
      (filter === "user-only" &&
        (message.role !== "user" ||
          !!message.tool_results?.length ||
          !!message.user_bash ||
          !!message.type)) ||
      (filter === "labeled-only" && !node.label?.trim())
    ) {
      continue;
    }
    const text =
      message.type === SESSION_RUNTIME_STATE && message.state
        ? `${SESSION_RUNTIME_STATE_LABEL}: ${message.state.provider.name} / ${message.state.provider.model} · thinking:${message.state.thinking}`
        : contentToText(message.content);
    const searchable = normalizeSessionSearchText(
      `${id} ${node.label ?? ""} ${text}`,
    );
    if (
      terms.every((term) =>
        term.startsWith(SESSION_TREE_ROLE_PREFIX)
          ? message.role === term.slice(SESSION_TREE_ROLE_PREFIX.length)
          : searchable.includes(term),
      )
    ) {
      rows.push({
        id,
        label: `${"  ".repeat(depth)}${node.label ?? (text || SESSION_TREE_TOOL_MESSAGE)}`,
        detail: `${SESSION_TREE_ROLE_PREFIX}${message.role} · ${id}`,
        current: id === leafId,
        onCurrentPath,
        depth,
        folded: folded.has(id),
        hasChildren: node.children.length > 0,
      });
    }
  }
  return rows;
}

export async function executeSessionFileTool(
  runtime: AgentRuntime,
  name: "ReadFile" | "WriteFile",
  args: Record<string, unknown>,
  permission: PermissionRequestHandler,
): Promise<void> {
  const tool = runtime.registry.get(name);
  if (!tool) {
    throw new Error(`${name} unavailable`);
  }
  const authorization = runtime.registry.captureAuthorization(name, "direct");
  const decision = runtime.checker.check(name, tool.category, args);
  if (decision.effect === "deny") {
    throw new Error(`Permission denied: ${decision.reason}`);
  }
  if (decision.effect === "ask") {
    const response = await requestToolPermission(
      permission,
      name,
      args,
      decision,
      randomUUID(),
    );
    if (response === "deny") {
      throw new Error("Permission denied");
    }
    if (response === "allowAlways") {
      runtime.checker.allowAlways(name, args);
    }
  }
  if (!runtime.registry.validateAuthorization(authorization)) {
    throw new Error("Tool authorization revoked");
  }
  const result = await tool.execute(
    {
      cwd: runtime.cwd,
      sessionId: runtime.sessionId,
      permissionChecker: runtime.checker,
      fileStateCache: runtime.fileStateCache,
      onPermissionRequest: permission,
      invocationEntry: "direct",
    },
    args,
  );
  if (result.isError) {
    throw new Error(result.output);
  }
}

export async function sessionTransferCommand(
  name: string,
  args: string,
  runtime: AgentRuntime,
  manager: SessionManager,
  ask: Asker,
  permission: PermissionRequestHandler,
): Promise<{ message: string; manager?: SessionManager }> {
  manager.refresh();
  if (name === "tags") {
    if (!args.trim()) {
      return {
        message: `Session tags: ${(manager.getMetadata().tags ?? []).join(", ") || "none"}`,
      };
    }
    const metadata = setSessionTags(
      manager,
      args.trim() === "clear" ? [] : args.split(","),
    );
    return {
      message: `Session tags: ${(metadata.tags ?? []).join(", ") || "none"}`,
    };
  }
  if (name === "name" && args.trim() === "suggest") {
    const preview = previewSessionNameSuggestion(manager);
    if (!preview) {
      return {
        message:
          "No local name suggestion is available; existing names are preserved.",
      };
    }
    const question = `Use this local session name?\n${preview.name}`;
    const answers = await ask([
      {
        question,
        multiSelect: false,
        options: [{ label: "adopt" }, { label: "cancel" }],
      },
    ]);
    if (answers[question] !== "adopt") {
      return { message: "Name suggestion canceled." };
    }
    if (!applySessionNameSuggestion(manager, preview)) {
      throw new Error("Session changed; reopen the name suggestion.");
    }
    return { message: `Session named ${preview.name}` };
  }
  if (name === "name") {
    manager.setName(args.trim());
    return { message: `Session named ${args.trim()}` };
  }
  if (name === "clone") {
    const cloned = manager.clone();
    return { manager: cloned, message: `Cloned session ${cloned.id}` };
  }
  if (name === "fork") {
    const id =
      args.trim() ||
      manager
        .getEntries()
        .findLast(
          (entry) =>
            entry.message.role === "user" &&
            !entry.message.tool_results?.length &&
            !entry.message.user_bash,
        )?.entryId;
    if (!id) {
      throw new Error("No user entry to fork");
    }
    const forked = manager.fork(id);
    return { manager: forked, message: `Forked session ${forked.id}` };
  }
  if (name === "import") {
    if (!args.trim()) {
      throw new Error("Usage: /import <jsonl file>");
    }
    const path = resolve(runtime.cwd, args.trim());
    await executeSessionFileTool(
      runtime,
      "ReadFile",
      { file_path: path },
      permission,
    );
    const imported = SessionManager.import(
      runtime.cwd,
      await readFile(path, "utf8"),
    );
    return { manager: imported, message: `Imported session ${imported.id}` };
  }
  if (name === "diagnostics") {
    const parts = args
      .trim()
      .split(SESSION_SEARCH_WHITESPACE_RE)
      .filter(Boolean);
    if (
      args.length > SESSION_TREE_COMMAND_MAX_CHARS ||
      parts.some(
        (part) => part.startsWith("--") && part !== "--include-transcript",
      )
    ) {
      throw new Error(LOCAL_DIAGNOSTICS_USAGE);
    }
    const content = manager.diagnostics({
      ...projectRuntimeDiagnostics(runtime),
      includeTranscript: parts.includes("--include-transcript"),
    });
    const file = parts
      .filter((part) => part !== "--include-transcript")
      .join(" ");
    if (!file) {
      return { message: content };
    }
    const path = resolve(runtime.cwd, file);
    const question = `Save this redacted local diagnostics preview to ${path}?\n${content}\nNo data is uploaded. Review the preview before saving.`;
    const answers = await ask([
      {
        question,
        multiSelect: false,
        options: [{ label: "save" }, { label: "cancel" }],
      },
    ]);
    if (answers[question] !== "save") {
      return { message: "Diagnostics save canceled." };
    }
    if (existsSync(path)) {
      const overwrite = `Overwrite ${path}?`;
      const confirmation = await ask([
        {
          question: overwrite,
          multiSelect: false,
          options: [{ label: "overwrite" }, { label: "cancel" }],
        },
      ]);
      if (confirmation[overwrite] !== "overwrite") {
        throw new Error("Overwrite canceled");
      }
      await executeSessionFileTool(
        runtime,
        "ReadFile",
        { file_path: path },
        permission,
      );
    }
    await executeSessionFileTool(
      runtime,
      "WriteFile",
      { file_path: path, content },
      permission,
    );
    return { message: `Saved diagnostics to ${path}` };
  }
  const parts = args.trim().split(/\s+/).filter(Boolean);
  const format = parts.includes("--html") ? "html" : "jsonl";
  const scope = parts.includes("--all") ? "tree" : "active";
  const file = parts.filter((part) => !part.startsWith("--")).join(" ");
  if (!file) {
    throw new Error(`Usage: /${name} <file> [--html] [--all]`);
  }
  const path = resolve(runtime.cwd, file);
  const content = manager.export({ format, scope });
  if (existsSync(path)) {
    const question = `Overwrite ${path}?`;
    const answers = await ask([
      {
        question,
        multiSelect: false,
        options: [{ label: "overwrite" }, { label: "cancel" }],
      },
    ]);
    if (answers[question] !== "overwrite") {
      throw new Error("Overwrite canceled");
    }
    await executeSessionFileTool(
      runtime,
      "ReadFile",
      { file_path: path },
      permission,
    );
  }
  await executeSessionFileTool(
    runtime,
    "WriteFile",
    { file_path: path, content },
    permission,
  );
  return { message: `Saved ${name} to ${path}` };
}

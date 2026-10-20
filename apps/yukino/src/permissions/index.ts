import { lstatSync, renameSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname, sep } from "node:path";

import yaml from "js-yaml";
import z, { parse } from "zod";

import { createChildLogger } from "@/logger/index.js";
import {
  CONTENT_FIELDS,
  DANGEROUS_PATTERNS,
  FILE_TOOLS,
  PLAN_COORDINATION_TOOLS,
  RULE_RE,
  SAFE_PREFIXES,
} from "@/permissions/constants.js";
import { analyzeShell } from "@/permissions/shell.js";
import { projectPath, yukinoPath } from "@/storage/index.js";
import {
  readPrivateFileSync as readFileSync,
  writePrivateFileSync as writeFileSync,
  mkdirPrivateSync as mkdirSync,
} from "@/storage/private.js";
import { TEAMMATE_COORDINATION_TOOLS } from "@/teams/constants.js";
import { withFileSyncLock } from "@/teams/file-lock.js";
import { mcpCallPermissionContent } from "@/tools/mcp-call.js";
import { asErrorString, isObject, isRecord, strArg } from "@/utils/index.js";
import { canonicalPath, isPathWithin, resolveToolPath } from "@/utils/paths.js";
import { OwnedWorktrees, type WorktreeResult } from "@/worktree/index.js";

export * as Constants from "@/permissions/constants.js";
export * as Request from "@/permissions/request.js";
export * as Shell from "@/permissions/shell.js";

const log = createChildLogger({ module: "permissions" });

export type DecisionEffect = "allow" | "deny" | "ask";
export type PermissionMode =
  "default" | "acceptEdits" | "plan" | "bypassPermissions";
export type NonPlanPermissionMode = Exclude<PermissionMode, "plan">;

export interface Decision {
  effect: DecisionEffect;
  reason: string;
  rememberPatterns?: string[];
}

type RuleEffect = DecisionEffect;

interface Rule {
  tool: string;
  pattern: string;
  effect: RuleEffect;
}

// Dangerous command patterns: each carries a match reason for HITL (Human-in-the-Loop) display
export interface DangerousPattern {
  re: RegExp;
  reason: string;
}

function escapeRuleLiteral(content: string): string {
  return content.replace(/[\\*?]/gu, "\\$&");
}

function normalizePathPattern(cwd: string, pattern: string): string {
  if (sep === "\\") {
    pattern = pattern.replaceAll("\\", "/");
  }
  if (pattern === "*") {
    return pattern;
  }
  let wildcard = -1;
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] === "\\") {
      i++;
    } else if (pattern[i] === "*" || pattern[i] === "?") {
      wildcard = i;
      break;
    }
  }
  const literal = (text: string) => text.replace(/\\(.)/gu, "$1");
  if (wildcard < 0) {
    return escapeRuleLiteral(
      canonicalPath(resolveToolPath(cwd, literal(pattern)))
        .split(sep)
        .join("/"),
    );
  }
  const slash = pattern.lastIndexOf("/", wildcard);
  const fixed = slash < 0 ? "." : pattern.slice(0, slash + 1);
  const suffix = pattern.slice(slash + 1);
  if (suffix.split("/").includes("..")) {
    throw new Error(
      "Permission path patterns cannot traverse after a wildcard",
    );
  }
  return `${escapeRuleLiteral(
    canonicalPath(resolveToolPath(cwd, literal(fixed)))
      .split(sep)
      .join("/"),
  ).replace(/\/$/u, "")}/${suffix}`;
}

export function extractContent(
  toolName: string,
  args: Record<string, unknown>,
): string {
  // The match target for McpCall is not a specific parameter but "which MCP
  // tool to call", derived from the server + tool parameters as server__tool.
  // This lets a rule like McpCall(linear__*) allow/deny per server or per tool.
  if (toolName === "McpCall") {
    return mcpCallPermissionContent(
      strArg(args, "server", ""),
      strArg(args, "tool", ""),
    );
  }
  const field = CONTENT_FIELDS[toolName];
  if (!field) {
    return "";
  }
  const v = args[field];
  if (typeof v === "string") {
    return v;
  }
  // ComputerUse also accepts the OpenAI batched form (actions[] instead of
  // action); summarize the action types so rule matching and prompts still see
  // what the call does.
  if (toolName === "ComputerUse" && Array.isArray(args.actions)) {
    return args.actions
      .map((item) => (isRecord(item) ? strArg(item, "type") : ""))
      .filter(Boolean)
      .join(",");
  }
  return "";
}

export class PathSandbox {
  private allowedRoots: string[];
  private projectDir: string;

  constructor(projectDir: string, includeTemp = true) {
    // Use os.tmpdir() instead of hardcoded "/tmp" — on macOS the temp dir
    // is /var/folders/..., not /tmp.
    this.projectDir = resolve(projectDir);
    this.allowedRoots = [this.projectDir, ...(includeTemp ? [tmpdir()] : [])];
  }

  addRoot(root: string): void {
    this.allowedRoots.push(resolveToolPath(this.projectDir, root));
  }

  check(filePath: string): Decision | null {
    const absolute = canonicalPath(resolveToolPath(this.projectDir, filePath));
    for (const root of this.allowedRoots) {
      if (isPathWithin(canonicalPath(root), absolute)) {
        return null;
      }
    }
    return {
      effect: "deny",
      reason: `Path ${filePath} is outside allowed directories`,
    };
  }
}

// Glob match where `*` matches any run of characters (including /) and `?`
// matches any single character — suited to matching shell commands rather
// than paths, so it deliberately deviates from filepath.Match semantics.
function globMatch(
  pattern: string,
  content: string,
  insensitive = false,
): boolean {
  let re = "^";
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === "\\" && i + 1 < pattern.length) {
      re += pattern[++i].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    } else if (char === "*") {
      re += "[\\s\\S]*";
    } else if (char === "?") {
      re += "[\\s\\S]";
    } else {
      re += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  re += "$";
  try {
    return new RegExp(re, insensitive ? "i" : "").test(content);
  } catch (err) {
    log.error({ err }, "permissions operation failed");
    return false;
  }
}

function isNodeJSErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return isObject(err) && "code" in err && typeof err.code === "string";
}

// Loads a rules file: a top-level YAML list of
// `{ rule: "Tool(pattern)", effect: "allow"|"deny"|"ask" }`.
function loadRulesFile(path: string): Rule[] {
  let data: string;
  try {
    data = readFileSync(path, "utf-8");
  } catch (err) {
    if (isNodeJSErrnoException(err) && err.code === "ENOENT") {
      return [];
    }
    throw err;
  }
  const YamlEntrySchema = z.object({
    rule: z.string().optional(),
    effect: z.string().optional(),
  });
  type YamlEntry = z.infer<typeof YamlEntrySchema>;
  let yamlData: YamlEntry[];
  try {
    const parsed: unknown = yaml.load(data);
    if (parsed === undefined || parsed === null) {
      return [];
    }
    yamlData = parse(z.array(YamlEntrySchema), parsed);
  } catch (err) {
    throw new Error("Cannot parse permission rules", { cause: err });
  }
  const rules: Rule[] = [];
  for (const entry of yamlData) {
    if (
      entry.effect !== "allow" &&
      entry.effect !== "deny" &&
      entry.effect !== "ask"
    ) {
      continue;
    }
    const m = RULE_RE.exec((entry.rule ?? "").trim());
    if (!m) {
      continue;
    }
    rules.push({ tool: m[1], pattern: m[2], effect: entry.effect });
  }
  return rules;
}

// Adjudicate over the given rule set with priority deny > ask > allow.
// Returns null when no rule matches.
export function evaluateRules(
  rules: Rule[],
  toolName: string,
  content: string,
): RuleEffect | null {
  let hit: RuleEffect | null = null;
  for (const r of rules) {
    if (r.tool !== toolName && r.tool !== "*") {
      continue;
    }
    if (
      !globMatch(
        r.pattern,
        content,
        toolName === "PowerShell" ||
          (sep === "\\" && (FILE_TOOLS.has(toolName) || toolName === "Glob")),
      )
    ) {
      continue;
    }
    // deny is the strictest effect and cannot be overridden; return immediately
    if (r.effect === "deny") {
      return "deny";
    }
    if (r.effect === "ask") {
      hit = "ask";
    }
    // allow is the weakest effect; record only when no stricter effect has matched yet
    else {
      hit ??= "allow";
    }
  }
  return hit;
}

// Parse result for a single rules file. mtimeNs + size together serve as the
// change indicator — either alone can miss a rewrite: filesystem timestamp
// granularity can be coarse, and a rewrite can preserve the previous size.
interface CachedRules {
  mtimeNs: bigint;
  size: bigint;
  rules: Rule[];
}

export class RuleEngine {
  private userPath: string;
  private projectPath: string;
  private cache = new Map<string, CachedRules>();

  constructor(cwd: string) {
    this.userPath = yukinoPath("permissions.yaml");
    this.projectPath = projectPath(cwd, "permissions.yaml");
  }

  // Read a single rules file; skips re-reading and parsing on cache hit.
  private rulesFor(path: string): Rule[] {
    let st;
    try {
      st = statSync(path, { bigint: true });
    } catch (error) {
      this.cache.delete(path);
      if (
        isNodeJSErrnoException(error) &&
        error.code === "ENOENT" &&
        !lstatSync(path, { throwIfNoEntry: false })
      ) {
        return [];
      }
      throw error;
    }

    const cached = this.cache.get(path);
    if (cached?.mtimeNs === st.mtimeNs && cached.size === st.size) {
      return cached.rules;
    }

    const rules = loadRulesFile(path);
    this.cache.set(path, { mtimeNs: st.mtimeNs, size: st.size, rules });
    return rules;
  }

  // Return the merged snapshot of both rules files. Reuses the previous
  // parse result when files are unchanged; re-reads only on change, so edits
  // take effect on the next evaluation without redundant parsing. Every call
  // still stats both files; callers that evaluate repeatedly within one
  // decision (e.g. compound-command checks) memoize and share one snapshot.
  snapshot(): Rule[] {
    return [this.userPath, this.projectPath].flatMap((p) => this.rulesFor(p));
  }

  // Persists a rule to the project-level YAML file in the `Tool(pattern)`
  // format so "allow always" survives a restart.
  appendProjectRule(rule: Rule): void {
    mkdirSync(dirname(this.projectPath), { recursive: true });
    withFileSyncLock(this.projectPath, () => {
      const rules = loadRulesFile(this.projectPath);
      const exists = rules.some(
        (r) =>
          r.tool === rule.tool &&
          r.pattern === rule.pattern &&
          r.effect === rule.effect,
      );
      if (exists) {
        return;
      }

      rules.push(rule);
      const entries = rules.map((r) => ({
        rule: `${r.tool}(${r.pattern})`,
        effect: r.effect,
      }));
      const tempPath = `${this.projectPath}.${String(process.pid)}.tmp`;
      try {
        writeFileSync(tempPath, yaml.dump(entries), "utf-8");
        renameSync(tempPath, this.projectPath);
        this.cache.delete(this.projectPath);
      } finally {
        rmSync(tempPath, { force: true });
      }
    });
  }
}

// Detect dangerous commands and return the matched reason (empty string means safe)
function detectDangerous(command: string): string {
  for (const p of DANGEROUS_PATTERNS) {
    if (p.re.test(command)) {
      return p.reason;
    }
  }
  return "";
}

export function isSafeCommand(command: string): boolean {
  const trimmed = command.trim();
  // Reject anything with shell metacharacters: a "safe" prefix like `cat` must
  // not become a gateway to piping/chaining/redirection/substitution.
  if (/[\r\n&|;<>`(){}[\]]/.test(trimmed)) {
    return false;
  }
  return SAFE_PREFIXES.some((prefix) => {
    if (typeof prefix === "string") {
      return (
        trimmed === prefix ||
        trimmed.startsWith(prefix + " ") ||
        trimmed.startsWith(prefix + "\t")
      );
    }
    // Defensive reset: a `g`/`y` regex would carry match state in lastIndex
    // between calls, so every command must start matching from position 0.
    prefix.lastIndex = 0;
    return prefix.test(trimmed);
  });
}

function modeDecide(
  mode: PermissionMode,
  category: "read" | "write" | "command",
): DecisionEffect {
  switch (mode) {
    case "bypassPermissions":
      return "allow";
    case "plan":
      return category === "read" ? "allow" : "deny";
    case "acceptEdits":
      return category === "command" ? "ask" : "allow";
    case "default":
    default:
      return category === "read" ? "allow" : "ask";
  }
}

export class PermissionChecker {
  private modeState: {
    value?: PermissionMode;
    listeners: Set<() => void>;
  };
  private planModeState: {
    previous?: NonPlanPermissionMode;
  };
  private parent?: PermissionChecker;
  planFilePath = "";
  teammate = false;
  readOnly = false;
  requiresLeaderPlanApproval = false;
  // Sandbox mode: when enabled, Bash commands run through OS sandbox isolation, with optional auto-allow
  sandboxEnabled = false;
  sandboxAutoAllow = false;
  private sandbox: PathSandbox;
  private ruleEngine: RuleEngine;
  worktrees = new OwnedWorktrees();
  private extraRoots: string[] = [];
  private isolatedRoot?: string;

  constructor(
    private readonly cwd: string,
    mode: PermissionMode = "default",
  ) {
    this.modeState = {
      value: mode,
      listeners: new Set(),
    };
    this.planModeState = {};
    this.sandbox = new PathSandbox(cwd);
    this.ruleEngine = new RuleEngine(cwd);
  }

  get mode(): PermissionMode {
    if (this.readOnly) {
      return "plan";
    }
    if (!this.parent) {
      return this.modeState.value ?? "default";
    }
    if (
      this.teammate &&
      this.requiresLeaderPlanApproval &&
      this.modeState.value === "plan"
    ) {
      return "plan";
    }
    const parentMode = this.parent.mode;
    const mode = this.modeState.value;
    if (parentMode === "bypassPermissions" || mode === "bypassPermissions") {
      return "bypassPermissions";
    }
    if (parentMode === "acceptEdits") {
      return "acceptEdits";
    }
    return mode ?? "default";
  }

  set mode(mode: PermissionMode) {
    if (this.modeState.value === mode) {
      return;
    }
    if (this.mode === "plan" && mode !== "plan") {
      this.planModeState.previous = undefined;
    }
    this.modeState.value = mode;
    for (const listener of this.modeState.listeners) {
      listener();
    }
  }

  subscribeMode(listener: () => void): () => void {
    this.modeState.listeners.add(listener);
    return () => {
      this.modeState.listeners.delete(listener);
    };
  }

  get isSubagent(): boolean {
    return this.parent !== undefined;
  }

  enterPlanMode(): NonPlanPermissionMode {
    if (this.mode === "plan") {
      return this.planModeState.previous ?? "default";
    }
    const previous = this.mode;
    this.planModeState.previous = previous;
    this.mode = "plan";
    return previous;
  }

  exitPlanMode(mode?: NonPlanPermissionMode): NonPlanPermissionMode {
    const next = mode ?? this.planModeState.previous ?? "default";
    this.mode = next;
    return next;
  }

  forCwd(cwd: string): PermissionChecker {
    const checker = new PermissionChecker(cwd, this.mode);
    checker.modeState = this.modeState;
    checker.planModeState = this.planModeState;
    checker.parent = this.parent;
    checker.planFilePath = this.planFilePath;
    checker.ruleEngine = this.ruleEngine;
    checker.worktrees = this.worktrees;
    checker.extraRoots = [...this.extraRoots];
    checker.isolatedRoot = this.isolatedRoot;
    checker.sandbox = new PathSandbox(
      this.isolatedRoot ?? cwd,
      !this.isolatedRoot,
    );
    for (const root of checker.extraRoots) {
      checker.sandbox.addRoot(root);
    }
    checker.teammate = this.teammate;
    checker.readOnly = this.readOnly;
    checker.requiresLeaderPlanApproval = this.requiresLeaderPlanApproval;
    checker.sandboxEnabled = this.sandboxEnabled;
    checker.sandboxAutoAllow = this.sandboxAutoAllow;
    return checker;
  }

  forSubagent(cwd: string, mode?: PermissionMode): PermissionChecker {
    const checker = this.forCwd(cwd);
    checker.parent = this;
    checker.modeState = { value: mode, listeners: this.modeState.listeners };
    checker.planModeState = {};
    if (!this.teammate) {
      checker.planFilePath = "";
    }
    return checker;
  }

  check(
    toolName: string,
    category: "read" | "write" | "command",
    args: Record<string, unknown>,
  ): Decision {
    try {
      return this.checkAction(toolName, category, args);
    } catch (error) {
      return {
        effect: "deny",
        reason: `Permission path resolution failed: ${asErrorString(error)}`,
      };
    }
  }

  private checkAction(
    toolName: string,
    category: "read" | "write" | "command",
    args: Record<string, unknown>,
  ): Decision {
    const content = extractContent(toolName, args);
    const coordination =
      this.teammate && TEAMMATE_COORDINATION_TOOLS.has(toolName);
    const filePath = strArg(args, "file_path", strArg(args, "path", ""));
    const planControl =
      this.mode === "plan" && PLAN_COORDINATION_TOOLS.has(toolName);
    const planFileWrite =
      this.mode === "plan" &&
      (toolName === "WriteFile" || toolName === "EditFile") &&
      !!this.planFilePath &&
      canonicalPath(resolveToolPath(this.cwd, filePath)) ===
        canonicalPath(resolveToolPath(this.cwd, this.planFilePath));
    if (
      this.mode === "plan" &&
      category !== "read" &&
      !coordination &&
      !planControl &&
      !planFileWrite &&
      !(category === "command" && isSafeCommand(content))
    ) {
      return {
        effect: "deny",
        reason: "Plan mode forbids mutations",
      };
    }

    const explicit = this.checkExplicitRules(toolName, args);
    const explicitEffect = explicit?.effect;
    if (explicit && explicit.effect !== "allow") {
      return explicit;
    }

    if (planControl) {
      return { effect: "allow", reason: "Plan coordination tool" };
    }

    // Layer 1.5: teammate coordination — internal team messaging and the
    // shared task board. Explicit deny/ask rules above still gate them.
    if (coordination) {
      return { effect: "allow", reason: "Teammate coordination tool" };
    }

    // Layer 0: plan-mode plan-file write exception.
    // Both WriteFile and EditFile targeting the plan file are allowed so the
    // model can create and update its plan.
    if (planFileWrite) {
      return {
        effect: "allow",
        reason: "Plan file write allowed in plan mode",
      };
    }

    // Layer 2: safe read-only command auto-allow (metaChar-guarded).
    if (category === "command" && isSafeCommand(content)) {
      return { effect: "allow", reason: "Safe read-only command" };
    }

    // Layer 3: dangerous command block — reason records the specific matched pattern
    const dangerReason = category === "command" ? detectDangerous(content) : "";
    if (dangerReason) {
      return {
        effect: "deny",
        reason: `Dangerous command blocked: ${dangerReason}`,
      };
    }

    if ((toolName === "Bash" || toolName === "PowerShell") && !content.trim()) {
      return {
        effect: "ask",
        reason:
          "Approval requires a non-empty Bash command or PowerShell command",
      };
    }

    if (
      (toolName === "Bash" || toolName === "PowerShell") &&
      !analyzeShell(content, toolName === "PowerShell").complete &&
      this.mode !== "bypassPermissions"
    ) {
      return {
        effect: "ask",
        reason: "Complex shell syntax requires approval",
      };
    }

    // Layer 3.5: Sandbox auto-allow — OS sandbox already isolates writes; non-dangerous commands can skip human confirmation.
    // Only Bash is wrapped by the configured OS sandbox; other command tools
    // (e.g. PowerShell) never inherit this auto-allow.
    if (this.sandboxEnabled && this.sandboxAutoAllow && toolName === "Bash") {
      return {
        effect: "allow",
        reason: "Sandbox auto-allow: OS sandbox active",
      };
    }

    // Layer 4: only writes need path approval; reads and bypass mode skip it.
    if (category === "write" && filePath && this.mode !== "bypassPermissions") {
      const sandboxDecision = this.sandbox.check(filePath);
      if (sandboxDecision && explicitEffect !== "allow") {
        return { effect: "ask", reason: sandboxDecision.reason };
      }
    }

    // Layer 5: rule engine — per-tool content + glob match.
    if (explicitEffect) {
      return {
        effect: explicitEffect,
        reason: `Permission rule: ${explicitEffect}`,
      };
    }

    // Layer 6: mode matrix.
    return {
      effect: modeDecide(this.mode, category),
      reason: `Mode: ${this.mode}`,
    };
  }

  // Allow writes to an extra directory outside the project + os.tmpdir().
  allowExtraRoot(path: string): void {
    const root = canonicalPath(resolveToolPath(this.cwd, path));
    this.extraRoots.push(root);
    this.sandbox.addRoot(root);
  }

  async registerWorktree(worktree: WorktreeResult): Promise<void> {
    if (await this.worktrees.register(worktree)) {
      this.allowExtraRoot(worktree.path);
    }
  }

  async forWorktree(worktree: WorktreeResult): Promise<PermissionChecker> {
    const checker = this.forCwd(worktree.path);
    checker.isolatedRoot = canonicalPath(worktree.path);
    checker.sandbox = new PathSandbox(checker.isolatedRoot, false);
    checker.extraRoots = [];
    checker.worktrees = new OwnedWorktrees();
    if (!(await checker.worktrees.register(worktree))) {
      throw new Error(
        "Cannot claim an existing worktree for an isolated agent",
      );
    }
    return checker;
  }

  sandboxWriteRoots(fallback: readonly string[]): string[] {
    return [
      ...new Set([
        ...(this.isolatedRoot ? [this.isolatedRoot] : fallback),
        ...this.extraRoots,
        ...this.worktrees.sandboxWriteRoots(),
      ]),
    ];
  }

  sandboxTempDirectory(): string | undefined {
    return this.isolatedRoot
      ? this.worktrees.tempDirectory(this.isolatedRoot)
      : undefined;
  }

  canReadSearchPath(_path: string): boolean {
    return true;
  }

  canTraverseSearchPath(path: string): boolean {
    return this.canReadSearchPath(path);
  }

  checkExplicitRules(
    toolName: string,
    args: Record<string, unknown>,
  ): Decision | null {
    try {
      const rules = this.ruleEngine
        .snapshot()
        .filter((rule) => rule.tool === toolName || rule.tool === "*")
        .map((rule) => ({
          ...rule,
          pattern:
            FILE_TOOLS.has(rule.tool) || rule.tool === "Glob"
              ? normalizePathPattern(this.cwd, rule.pattern)
              : rule.pattern,
        }));
      const rawContent = extractContent(toolName, args);
      let effect: RuleEffect | null;
      if (toolName === "Bash" || toolName === "PowerShell") {
        const analysis = analyzeShell(rawContent, toolName === "PowerShell");
        const effects = [
          evaluateRules(rules, toolName, rawContent),
          ...analysis.commands.flatMap((command) => [
            evaluateRules(rules, toolName, command.content),
            evaluateRules(
              rules.filter((rule) => rule.effect !== "allow"),
              toolName,
              [
                command.words[0].split(/[\\/]/u).at(-1),
                ...command.words.slice(1),
              ].join(" "),
            ),
          ]),
        ];
        if (effects.includes("deny")) {
          effect = "deny";
        } else if (!analysis.complete) {
          const restrictive = rules.filter(
            (rule) =>
              (rule.tool === toolName || rule.tool === "*") &&
              rule.effect !== "allow",
          );
          effect = restrictive.some((rule) => rule.effect === "deny")
            ? "deny"
            : "ask";
          if (!restrictive.length) {
            effect = null;
          }
        } else if (effects.includes("ask")) {
          effect = "ask";
        } else {
          effect =
            analysis.commands.length > 0 &&
            analysis.commands.every(
              (command) =>
                evaluateRules(rules, toolName, command.content) === "allow",
            )
              ? "allow"
              : null;
        }
      } else {
        const content =
          FILE_TOOLS.has(toolName) && rawContent
            ? canonicalPath(resolveToolPath(this.cwd, rawContent))
                .split(sep)
                .join("/")
            : toolName === "Glob" && rawContent
              ? normalizePathPattern(
                  resolveToolPath(this.cwd, strArg(args, "path", ".")),
                  rawContent,
                )
              : rawContent;
        effect = evaluateRules(rules, toolName, content);
      }
      return effect ? { effect, reason: `Permission rule: ${effect}` } : null;
    } catch (error) {
      return {
        effect: "deny",
        reason: `Permission path resolution failed: ${asErrorString(error)}`,
      };
    }
  }

  rememberPatterns(toolName: string, args: Record<string, unknown>): string[] {
    const content = extractContent(toolName, args);
    if (!content) {
      return [];
    }
    if (FILE_TOOLS.has(toolName)) {
      const abs = canonicalPath(resolveToolPath(this.cwd, content));
      const isDir = statSync(abs, { throwIfNoEntry: false })?.isDirectory();
      return [
        `${toolName}(${escapeRuleLiteral((isDir ? abs : dirname(abs)).split(sep).join("/")).replace(/\/$/u, "")}/*)`,
      ];
    }
    if (toolName === "Bash" || toolName === "PowerShell") {
      const analysis = analyzeShell(content, toolName === "PowerShell");
      if (
        !analysis.complete ||
        analysis.commands.some((command) =>
          command.words.slice(0, 2).some((word) => /[\s*?\\]/u.test(word)),
        )
      ) {
        return [];
      }
      return [
        ...new Set(
          analysis.commands.map(
            (command) =>
              `${toolName}(${escapeRuleLiteral(command.words.slice(0, 2).join(" "))}*)`,
          ),
        ),
      ];
    }
    if (
      toolName === "McpCall" &&
      (!strArg(args, "server") || !strArg(args, "tool"))
    ) {
      return [];
    }
    if (
      toolName === "McpCall" ||
      toolName === "WebFetch" ||
      toolName === "InstallSkill" ||
      toolName === "TaskOutput"
    ) {
      return [`${toolName}(${escapeRuleLiteral(content)})`];
    }
    return [];
  }

  allowAlways(
    toolName: string,
    args: Record<string, unknown>,
    patterns = this.rememberPatterns(toolName, args),
  ): void {
    for (const pattern of patterns) {
      const match = RULE_RE.exec(pattern);
      if (match?.[1] === toolName) {
        this.ruleEngine.appendProjectRule({
          tool: match[1],
          pattern: match[2],
          effect: "allow",
        });
      }
    }
  }

  /**
   * Generate a human-readable description of the tool action for display in HITL confirmation dialogs.
   * Prefers the per-tool match content from extractContent (e.g., command, file_path,
   * or McpCall's server__tool); falls back to a key:value summary of parameters when there is none.
   */
  describeToolAction(toolName: string, args: Record<string, unknown>): string {
    const content = extractContent(toolName, args);
    if (content) {
      return content;
    }
    // Fallback: concatenate key: value for all parameters, truncating overly long values
    const parts: string[] = [];
    for (const [k, v] of Object.entries(args)) {
      let s = String(v);
      if (s.length > 80) {
        s = s.slice(0, 80) + "...";
      }
      parts.push(`${k}: ${s}`);
    }
    return parts.join(", ");
  }
}

import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";

import yaml from "js-yaml";
import z, { parse } from "zod";

import { createChildLogger } from "@/logger/index.js";
import { projectPath, yukinoPath } from "@/storage/paths.js";
import { withFileSyncLock } from "@/teams/file-lock.js";
import { TEAMMATE_COORDINATION_TOOLS } from "@/teams/protocol.js";
import { mcpCallPermissionContent } from "@/tools/mcp-call.js";
import { isObject, isRecord, strArg } from "@/utils/index.js";
import { canonicalPath, isPathWithin, resolveToolPath } from "@/utils/paths.js";

export * as Request from "./request.js";

const log = createChildLogger({ module: "permissions" });

export type DecisionEffect = "allow" | "deny" | "ask";
export type PermissionMode =
  "default" | "acceptEdits" | "plan" | "bypassPermissions";

export interface Decision {
  effect: DecisionEffect;
  reason: string;
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

// Intentionally empty: no command patterns are currently classified as
// dangerous, so detectDangerous() below never matches and the Layer-3 deny
// stays inert until patterns are added.
export const DANGEROUS_PATTERNS: DangerousPattern[] = [];

export const SAFE_PREFIXES: (string | RegExp)[] = [
  "echo", // Output only, no dangerous flags
  "printf", // xargs runs /usr/bin/printf (binary), not bash builtin — no -v support
  "wc", // Read-only counting, no dangerous flags
  "grep", // Read-only search, no dangerous flags
  "head", // Read-only, no dangerous flags
  "tail", // Read-only (including -f follow), no dangerous flags

  // Cross-platform commands from shared validation
  /docker\s+(?:ps|images)\b/,

  // Unix/bash-specific read-only commands (not shared because they don't exist in PowerShell)

  // Time and date
  "cal",
  "uptime",

  // File content viewing (relative paths handled separately)
  "cat",
  "head",
  "tail",
  "wc",
  "stat",
  "strings",
  "hexdump",
  "od",
  "nl",

  // System info
  "id",
  "uname",
  "free",
  "df",
  "du",
  "locale",
  "groups",
  "nproc",

  // Path information
  "basename",
  "dirname",
  "realpath",

  // Text processing
  "cut",
  "paste",
  "tr",
  "column",
  "tac", // Reverse cat — displays file contents in reverse line order
  "rev", // Reverse characters in each line
  "fold", // Wrap lines to specified width
  "expand", // Convert tabs to spaces
  "unexpand", // Convert spaces to tabs
  "fmt", // Simple text formatter — output to stdout only
  "comm", // Compare sorted files line by line
  "cmp", // Byte-by-byte file comparison
  "numfmt", // Number format conversion

  // Path information (additional)
  "readlink", // Resolve symlinks — displays target of symbolic link

  // File comparison
  "diff",

  // true and false, used to silence or create errors
  "true",
  "false",

  // Misc. safe commands
  "sleep",
  "which",
  "type",
  "expr", // Evaluate expressions (arithmetic, string matching)
  "test", // Conditional evaluation (file checks, comparisons)
  "getconf", // Get system configuration values
  "seq", // Generate number sequences
  "tsort", // Topological sort
  "pr", // Paginate files for printing
];

// Per-tool argument field treated as the "content" for safe/dangerous checks and rule matching
const CONTENT_FIELDS: Record<string, string> = {
  Bash: "command",
  PowerShell: "command",
  ComputerUse: "action",
  ReadFile: "file_path",
  LSP: "file_path",
  WebFetch: "url",
  WebSearch: "query",
  TaskOutput: "task_id",
  WriteFile: "file_path",
  EditFile: "file_path",
  Glob: "pattern",
  Grep: "pattern",
  InstallSkill: "source",
};

const PLAN_COORDINATION_TOOLS = new Set([
  "AskUserQuestion",
  "ExitPlanMode",
  "Agent",
  "Goal",
  "TodoWrite",
  "TaskStop",
  "TeamCreate",
  "TeamDelete",
  ...TEAMMATE_COORDINATION_TOOLS,
]);

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

  constructor(projectDir: string) {
    // Use os.tmpdir() instead of hardcoded "/tmp" — on macOS the temp dir
    // is /var/folders/..., not /tmp.
    this.projectDir = resolve(projectDir);
    this.allowedRoots = [this.projectDir, tmpdir()];
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
function globMatch(pattern: string, content: string): boolean {
  const re =
    "^" +
    pattern
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, ".*")
      .replace(/\?/g, ".") +
    "$";
  try {
    return new RegExp(re).test(content);
  } catch (err) {
    log.error({ err }, "permissions operation failed");
    return false;
  }
}

const RULE_RE = /^(\w+)\((.+)\)$/;

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
    if (isNodeJSErrnoException(err) && err.code !== "ENOENT") {
      log.error({ err }, "permissions operation failed");
    }
    return [];
  }
  const YamlEntrySchema = z.object({
    rule: z.string().optional(),
    effect: z.string().optional(),
  });
  type YamlEntry = z.infer<typeof YamlEntrySchema>;
  let yamlData: YamlEntry[];
  try {
    const parsed: unknown = yaml.load(data);
    yamlData = parse(z.array(YamlEntrySchema), parsed);
  } catch (err) {
    log.error({ err }, "permissions operation failed");
    return [];
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
    if (!globMatch(r.pattern, content)) {
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
    } catch {
      // File missing or unreadable — treat as empty rules and clear any stale cache entry
      this.cache.delete(path);
      return [];
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
  private parent?: PermissionChecker;
  planFilePath = "";
  teammate = false;
  // Sandbox mode: when enabled, Bash commands run through OS sandbox isolation, with optional auto-allow
  sandboxEnabled = false;
  sandboxAutoAllow = false;
  private sandbox: PathSandbox;
  private ruleEngine: RuleEngine;

  constructor(
    private readonly cwd: string,
    mode: PermissionMode = "default",
  ) {
    this.modeState = {
      value: mode,
      listeners: new Set(),
    };
    this.sandbox = new PathSandbox(cwd);
    this.ruleEngine = new RuleEngine(cwd);
  }

  get mode(): PermissionMode {
    if (!this.parent) {
      return this.modeState.value ?? "default";
    }
    const parentMode = this.parent.mode;
    if (parentMode === "acceptEdits" || parentMode === "bypassPermissions") {
      return parentMode;
    }
    const mode = this.modeState.value;
    return mode === "bypassPermissions" ? parentMode : (mode ?? parentMode);
  }

  set mode(mode: PermissionMode) {
    if (this.modeState.value === mode) {
      return;
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

  forCwd(cwd: string): PermissionChecker {
    const checker = new PermissionChecker(cwd, this.mode);
    checker.modeState = this.modeState;
    checker.parent = this.parent;
    checker.planFilePath = this.planFilePath;
    checker.ruleEngine = this.ruleEngine;
    checker.teammate = this.teammate;
    checker.sandboxEnabled = this.sandboxEnabled;
    checker.sandboxAutoAllow = this.sandboxAutoAllow;
    return checker;
  }

  forSubagent(cwd: string, mode?: PermissionMode): PermissionChecker {
    const checker = this.forCwd(cwd);
    checker.parent = this;
    checker.modeState = { value: mode, listeners: this.modeState.listeners };
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

    // Layer 1: explicit rules, evaluated first so a deny/ask also gates the
    // Layer-0 plan-file write exception. The snapshot is taken lazily and shared
    // with the Layer-3.5 sub-command checks. Only deny/ask short-circuit here:
    // an explicit allow deliberately falls through so the dangerous-command
    // and per-subcommand checks below can still take precedence, and
    // is returned at Layer 5 if none fires.
    let snapshot: Rule[] | null = null;
    const rules = (): Rule[] => (snapshot ??= this.ruleEngine.snapshot());
    const explicitEffect = evaluateRules(rules(), toolName, content);
    if (explicitEffect === "deny" || explicitEffect === "ask") {
      return {
        effect: explicitEffect,
        reason: `Permission rule: ${explicitEffect}`,
      };
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

    // Layer 3.5: Sandbox auto-allow — OS sandbox already isolates writes; non-dangerous commands can skip human confirmation.
    // Split compound commands and check deny/ask rules individually to prevent bypassing permission checks via command chaining.
    // Only Bash is wrapped by the configured OS sandbox; other command tools
    // (e.g. PowerShell) never inherit this auto-allow.
    if (this.sandboxEnabled && this.sandboxAutoAllow && toolName === "Bash") {
      const command = strArg(args, "command").trim();
      if (!command) {
        return {
          effect: "ask",
          reason: "Sandbox auto-allow requires a non-empty Bash command",
        };
      }
      // Split on every chaining separator — single & (backgrounding still
      // runs the next command), newlines, and the compound operators — so an
      // anchored deny/ask rule cannot be dodged by hiding a subcommand in a
      // segment the splitter kept whole. (isSafeCommand already rejects raw
      // & / newline / ; / | commands upstream; this keeps the layers
      // consistent regardless.)
      const subcommands = command
        .split(/\s*(?:&&|\|\||&|[;|\n\r])\s*/)
        .map((s) => s.trim())
        .filter(Boolean);
      let hasAsk = false;
      for (const sub of subcommands) {
        const ruleResult = evaluateRules(rules(), toolName, sub);
        if (ruleResult === "deny") {
          return { effect: "deny", reason: "Permission rule: deny" };
        }
        if (ruleResult === "ask") {
          hasAsk = true;
        }
      }
      if (hasAsk) {
        return {
          effect: "ask",
          reason: "Permission rule: ask (sandbox does not override)",
        };
      }
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
    this.sandbox.addRoot(path);
  }

  // Persist a scoped "allow always" rule.
  // - File path: parent directory + `/*` (a directory path uses itself + `/*`).
  // - Command: first 1-2 words + `*` so it allows that command family.
  allowAlways(toolName: string, args: Record<string, unknown>): void {
    const content = extractContent(toolName, args);
    const isFilePath =
      toolName === "ReadFile" ||
      toolName === "WriteFile" ||
      toolName === "EditFile";
    let pattern: string;
    if (isFilePath && content) {
      const abs = resolveToolPath(this.cwd, content);
      let isDir = false;
      try {
        isDir = statSync(abs).isDirectory();
      } catch {
        // Path may not exist yet (e.g. WriteFile creating a new file) — treat as file.
      }
      pattern = join(isDir ? abs : dirname(abs), "*");
    } else {
      const words = content.trim().split(/\s+/).slice(0, 2);
      pattern = words.join(" ") + "*";
    }
    this.ruleEngine.appendProjectRule({
      tool: toolName,
      pattern,
      effect: "allow",
    });
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

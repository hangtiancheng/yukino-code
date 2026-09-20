/**
 * Copyright (c) 2026 hangtiancheng
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

import { readFileSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";

import yaml from "js-yaml";
import z, { parse } from "zod";

import { createChildLogger } from "@/logger/index.js";
import { mcpCallPermissionContent } from "@/tools/mcp-call.js";
import { isRecord, strArg } from "@/utils/index.js";
import { canonicalPath, isPathWithin } from "@/utils/paths.js";

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
interface DangerousPattern {
  re: RegExp;
  reason: string;
}

// Keep it empty array
const DANGEROUS_PATTERNS: DangerousPattern[] = [];

const SAFE_PREFIXES: (string | RegExp)[] = [
  "basename",
  "cat",
  "cksum",
  "cmp",
  "column",
  "comm",
  "cut",
  "df",
  "dirname",
  "du",
  "echo",
  "expr",
  "false",
  "fold",
  "fmt",
  "grep",
  "groups",
  "head",
  "id",
  "jq",
  "locate",
  "ls",
  "md5",
  "md5sum",
  "nl",
  "od",
  "paste",
  "pgrep",
  "printenv",
  "printf",
  "ps",
  "pwd",
  "readlink",
  "realpath",
  "sha1sum",
  "sha224sum",
  "sha256sum",
  "sha384sum",
  "sha512sum",
  "shasum",
  "stat",
  "strings",
  "tac",
  "tail",
  "tr",
  "true",
  "tty",
  "type",
  "uname",
  "uptime",
  "w",
  "wc",
  "whereis",
  "which",
  "who",
  "whoami",
  "ack",
  "ag",
  "alias",
  "arch",
  "base64",
  "bat",
  "bzcat",
  "cal",
  "col",
  "cloc",
  "diff",
  "diff3",
  "dig",
  "dmesg",
  "expand",
  "factor",
  "free",
  "help",
  "hexdump",
  "host",
  "iconv",
  "info",
  "locale",
  "lscpu",
  "lsblk",
  "lsof",
  "lspci",
  "lsusb",
  "man",
  "mdfind",
  "mdls",
  "ncal",
  "netstat",
  "nproc",
  "nslookup",
  "objdump",
  "otool",
  "pbpaste",
  "ping",
  "readelf",
  "rev",
  "sdiff",
  "seq",
  "sum",
  "sw_vers",
  "tldr",
  "traceroute",
  "unexpand",
  "vm_stat",
  "whois",
  "xxd",
  "xzcat",
  "zcat",
  "zgrep",
  "zipinfo",
  /^command\s+(?:-v|-V)\s+\S+(?:\s+\S+)*$/,
  /^date(?!.*\s(?:-s|--set)(?:=|\s|$))(?:\s.*)?$/,
  /^file(?!.*(?:\s--compile(?:=|\s|$)|\s-[^-\s]*C))(?:\s.*)?$/,
  /^find(?!.*\s(?:-delete|-exec(?:dir)?|-ok(?:dir)?|-fls|-fprint(?:0)?|-fprintf)(?:\s|$))(?:\s.*)?$/,
  /^fd(?!.*\s(?:-x|-X|--exec|--exec-batch)(?:=|\s|$))(?:\s.*)?$/,
  /^hostname(?:\s+(?:-[adfFiIsyVh]|--(?:alias|all-fqdns|all-ip-addresses|domain|fqdn|help|ip-address|long|nis|short|version|yp)))*$/,
  /^rg(?!.*\s(?:--pre|--pre-glob|--hostname-bin)(?:=|\s|$))(?:\s.*)?$/,
  /^sort(?!.*\s(?:-o|--output|--compress-program)(?:=|\s|$))(?:\s.*)?$/,
  /^ss(?!.*\s(?:--kill|-[^-\s]*K)(?:\s|$))(?:\s.*)?$/,
  /^tree(?!.*\s(?:-o|--output)(?:=|\s|$))(?:\s.*)?$/,
  /^git\s+(?:--version|version)$/,
  /^git\s+(?:blame|cat-file|count-objects|describe|for-each-ref|ls-files|ls-tree|merge-base|name-rev|rev-parse|shortlog|show-ref|status|verify-pack)(?:\s.*)?$/,
  /^git\s+(?:diff|log|show)(?!.*\s(?:--ext-diff|--output)(?:=|\s|$))(?:\s.*)?$/,
  /^git\s+branch$/,
  /^git\s+branch(?=.*\s(?:-a|--all|-r|--remotes|--list|--show-current|--contains|--no-contains|--merged|--no-merged)(?:=|\s|$))(?!.*\s(?:-[dDmMcCf]|--(?:copy|create-reflog|delete|edit-description|move|set-upstream-to|unset-upstream))(?:=|\s|$))(?:\s.*)?$/,
  /^git\s+config(?:\s+(?:--blob(?:=|\s)\S+|--file(?:=|\s)\S+|--fixed-value|--global|--local|--null|--show-names|--show-origin|--show-scope|--system|--worktree|-z))*\s+(?:--get|--get-all|--get-regexp|--get-urlmatch|--list|-l)(?:\s.*)?$/,
  /^git\s+notes\s+(?:list|show)(?:\s.*)?$/,
  /^git\s+reflog\s+show(?:\s.*)?$/,
  /^git\s+remote(?:\s+-v)?$/,
  /^git\s+remote\s+get-url(?:\s+(?:--all|--push))*\s+\S+$/,
  /^git\s+remote\s+show(?:\s+-n)?(?:\s+\S+)?$/,
  /^git\s+stash\s+(?:list|show)(?:\s.*)?$/,
  /^git\s+submodule\s+(?:status|summary)(?:\s.*)?$/,
  /^git\s+tag(?:\s+(?:-l|--list)(?:\s.*)?)?$/,
  /^git\s+worktree\s+list(?:\s.*)?$/,
  /^(?:bun|npm|pnpm|yarn)\s+(?:explain|help|info|list|ls|outdated|prefix|query|root|search|show|view|why)(?:\s.*)?$/,
  /^(?:npm|pnpm|yarn)\s+config\s+(?:get|list)(?:\s.*)?$/,
  /^npm\s+pkg\s+get(?:\s.*)?$/,
  /^bun\s+pm\s+ls(?:\s.*)?$/,
  /^(?:bun|cargo|clang|cmake|composer|deno|gcc|gem|node|npm|php|pip|pip3|pnpm|python|python3|ruby|rustc|swift|yarn)\s+(?:--version|-V)$/,
  /^(?:go|helm|kubectl|podman|terraform)\s+version(?:\s.*)?$/,
  /^(?:java|javac)\s+-version$/,
  /^dotnet\s+(?:--info|--list-runtimes|--list-sdks|--version)$/,
  /^(?:docker|podman)\s+(?:diff|events|images|info|inspect|logs|port|ps|stats|top|version)(?:\s.*)?$/,
  /^(?:docker|podman)\s+(?:container|image|network|volume)\s+(?:inspect|ls)(?:\s.*)?$/,
  /^docker\s+compose\s+(?:config|images|logs|ps|top|version)(?:\s.*)?$/,
  /^kubectl\s+(?:api-resources|api-versions|cluster-info|describe|explain|get|logs|top|version)(?:\s.*)?$/,
  /^kubectl\s+config\s+(?:current-context|get-contexts|view)(?:\s.*)?$/,
  /^helm\s+(?:env|get|history|list|search|show|status|version)(?:\s.*)?$/,
  /^terraform\s+(?:output|providers|show|version)(?:\s.*)?$/,
  /^terraform\s+workspace\s+(?:list|show)(?:\s.*)?$/,
  /^systemctl\s+(?:is-active|is-enabled|is-failed|list-dependencies|list-jobs|list-sockets|list-timers|list-unit-files|list-units|show|show-environment|status)(?:\s.*)?$/,
  /^launchctl\s+(?:error|hostinfo|list|managername|managerpid|manageruid|print|print-cache|procinfo|variant|version)(?:\s.*)?$/,
  /^journalctl(?!.*\s--(?:rotate|vacuum|flush|sync))(?:\s.*)?$/,
  /^defaults\s+read(?:\s.*)?$/,
  /^ifconfig$/,
  /^ipconfig(?:\s+\/(?:all|allcompartments|displaydns))?\s*$/,
  /^ip\s+(?:addr(?:ess)?|route)$/,
  /^ip\s+(?:addr(?:ess)?|link|route|neigh(?:bor)?)\s+(?:show|list)\b(?:\s.*)?$/,
  /^tar\s+(?:--list\b|-[a-zA-Z]*t[a-zA-Z]*)(?:\s.*)?$/,
  /^unzip\s+-[a-zA-Z]*l(?:\s.*)?$/,
  /^git\s+(?:grep|fsck|rev-list|whatchanged|help|diff-tree|diff-index|diff-files|ls-remote|verify-tag|verify-commit)(?:\s.*)?$/,
  /^git\s+archive(?!.*\s(?:-o|--output)(?:=|\s|$))(?:\s.*)?$/,
  /^svn\s+(?:status|stat|st|diff|di|log|info|list|ls|cat|blame|ann|annotate|proplist|propget|pg)(?:\s.*)?$/,
  /^hg\s+(?:status|st|log|diff|summary|id|identify|branches|tags|manifest|cat|files|locate|heads|tip|parents|paths|root)(?:\s.*)?$/,
  /^cargo\s+(?:tree|search|locate-project|verify-project|config\s+get)(?:\s.*)?$/,
  /^gem\s+(?:list|search|info|env|dependency|contents|specification|sources\s+(?:-l|--list))(?:\s.*)?$/,
  /^brew\s+(?:--version|-v|list|info|search|outdated|deps|uses|config|leaves|doctor)(?:\s.*)?$/,
  /^choco\s+(?:--version|list|info|search|outdated)(?:\s.*)?$/,
  /^apt(?:-get)?\s+list(?:\s.*)?$/,
  /^apt-cache\s+(?:search|show|showpkg|policy|depends|rdepends|pkgnames)(?:\s.*)?$/,
  /^dpkg\s+(?:-l|-L|-s|-S|--list|--listfiles|--status|--search)\b(?:\s.*)?$/,
  /^rpm\s+-q[a-zA-Z]*(?:\s.*)?$/,
  /^(?:aws|gh|gcloud|az)\s+--version$/,
  /^aws\s+(?:\S+\s+)?(?:describe|list|get|wait)-\S+(?:\s.*)?$/,
  /^aws\s+s3\s+ls(?:\s.*)?$/,
  /^gcloud\s+\S+(?:\s+\S+)*\s+(?:list|describe)(?:\s.*)?$/,
  /^az\s+\S+(?:\s+\S+)*\s+(?:list|show)(?:\s.*)?$/,
  /^gh\s+(?:pr|issue|repo|run|release|gist)\s+(?:view|list|status|checks|diff)(?:\s.*)?$/,
  /^(?:docker|podman)\s+(?:system\s+(?:df|info)|history|context\s+(?:ls|list|show|inspect))(?:\s.*)?$/,
  /^(?:Get-(?:Acl|Alias|AuthenticodeSignature|ChildItem|CimInstance|Clipboard|Command|ComputerInfo|Content|Counter|Culture|Date|DnsClientCache|EventLog|ExecutionPolicy|FileHash|Help|History|Host|HotFix|Item|ItemProperty|Location|Member|Module|NetAdapter|NetIPAddress|NetNeighbor|NetIPConfiguration|NetRoute|NetTCPConnection|NetUDPEndpoint|Package|PackageProvider|PnpDevice|Printer|Process|PSDrive|PSProvider|PSRepository|PSSnapin|ScheduledTask|Service|TimeZone|UICulture|Variable|Verb|WinEvent|WmiObject)|Compare-Object|Format-(?:Custom|Hex|List|Table|Wide)|Group-Object|Measure-Object|Out-String|Resolve-Path|Select-Object|Select-String|Sort-Object|Test-Path|Where-Object|Write-(?:Debug|Error|Host|Information|Output|Progress|Verbose|Warning))(?:\s.*)?$/i,
];

// Per-tool argument field treated as the "content" for safe/dangerous checks and rule matching
const CONTENT_FIELDS: Record<string, string> = {
  Bash: "command",
  PowerShell: "command",
  ComputerUse: "action",
  ReadFile: "file_path",
  WriteFile: "file_path",
  EditFile: "file_path",
  Glob: "pattern",
  Grep: "pattern",
  InstallSkill: "source",
};

const DEFAULT_DENY_WRITE: string[] = [];

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
  private denyWritePaths: string[];
  private projectDir: string;

  constructor(projectDir: string) {
    // Use os.tmpdir() instead of hardcoded "/tmp" — on macOS the temp dir
    // is /var/folders/..., not /tmp.
    this.projectDir = resolve(projectDir);
    this.allowedRoots = [this.projectDir, tmpdir()];
    // Convert relative paths to absolute paths
    this.denyWritePaths = DEFAULT_DENY_WRITE.map((p) =>
      join(this.projectDir, p),
    );
  }

  addRoot(root: string): void {
    this.allowedRoots.push(resolve(root));
  }
  // Add custom deny-write paths
  addDenyWrite(path: string): void {
    this.denyWritePaths.push(resolve(path));
  }

  /**
   * Check whether a path is in the deny-write list.
   * denyWrite has the highest priority — even if the path is within an allowed root, writes are still denied.
   */
  checkDenyWrite(filePath: string): Decision | null {
    const absolute = resolve(this.projectDir, filePath);
    const canonical = canonicalPath(absolute);
    for (const denied of this.denyWritePaths) {
      if (
        isPathWithin(denied, absolute) ||
        isPathWithin(canonicalPath(denied), canonical)
      ) {
        return {
          effect: "deny",
          reason: `Path ${filePath} is in deny-write list`,
        };
      }
    }
    return null;
  }

  check(filePath: string): Decision | null {
    const absolute = canonicalPath(resolve(this.projectDir, filePath));
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
      // In bash commands, * should match any character including / (commands are not paths)
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

// Loads a rules file: a top-level YAML list of
// `{ rule: "Tool(pattern)", effect: "allow"|"deny" }`.
function loadRulesFile(path: string): Rule[] {
  let data: string;
  try {
    data = readFileSync(path, "utf-8");
  } catch (err) {
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
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

// Parse result for a single rules file. mtime + size together serve as the
// change indicator — mtime alone is insufficient because consecutive writes
// within the same millisecond may leave the timestamp unchanged.
interface CachedRules {
  mtimeNs: bigint;
  size: bigint;
  rules: Rule[];
}

export class RuleEngine {
  private userPath: string;
  private projectPath: string;
  private cache = new Map<string, CachedRules>();

  constructor(workDir: string) {
    this.userPath = join(homedir(), ".yukino", "permissions.yaml");
    this.projectPath = join(workDir, ".yukino", "permissions.yaml");
  }

  // Read a single rules file; skips disk I/O and parsing on cache hit.
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
  // take effect on the next evaluation without redundant parsing. One snapshot
  // is taken per tool call and shared across sub-command checks.
  snapshot(): Rule[] {
    return [this.userPath, this.projectPath].flatMap((p) => this.rulesFor(p));
  }

  // Take a snapshot then adjudicate: reuses the previous parse result when
  // files are unchanged; a freshly written "allow always" rule takes effect
  // immediately. Priority is deny > ask > allow regardless of which layer or
  // line a rule resides on, so a deny cannot be overridden by an allow from
  // another layer. Returns null when no rule matches.
  evaluate(toolName: string, content: string): RuleEffect | null {
    return evaluateRules(this.snapshot(), toolName, content);
  }

  // Persists a rule to the project-level YAML file in the `Tool(pattern)`
  // format so "allow always" survives a restart.
  appendProjectRule(rule: Rule): void {
    mkdirSync(dirname(this.projectPath), { recursive: true });
    const rules = loadRulesFile(this.projectPath);
    // Deduplicate: skip if an identical {tool, pattern, effect} rule already
    // exists. Without this, every "allow always" click on the same command
    // appends a duplicate entry (the rule engine matches but allowAlways is
    // still called in some flows, e.g. cross-session content variants).
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
    writeFileSync(this.projectPath, yaml.dump(entries), "utf-8");
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
    // `g`/`y` regexes keep match state in lastIndex, which would leak between
    // commands and let a later unsafe command pass, so restart the match.
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
      return category === "read" ? "allow" : "ask";
    case "acceptEdits":
      return category === "command" ? "ask" : "allow";
    case "default":
    default:
      return category === "read" ? "allow" : "ask";
  }
}

export class PermissionChecker {
  mode: PermissionMode;
  planFilePath = "";
  // Sandbox mode: when enabled, command-category tools run through OS sandbox isolation, with optional auto-allow
  sandboxEnabled = false;
  sandboxAutoAllow = false;
  private sandbox: PathSandbox;
  private ruleEngine: RuleEngine;

  constructor(
    private readonly workDir: string,
    mode: PermissionMode = "default",
  ) {
    this.mode = mode;
    this.sandbox = new PathSandbox(workDir);
    this.ruleEngine = new RuleEngine(workDir);
  }

  forWorkDir(workDir: string): PermissionChecker {
    const checker = new PermissionChecker(workDir, this.mode);
    checker.ruleEngine = this.ruleEngine;
    checker.sandboxEnabled = this.sandboxEnabled;
    checker.sandboxAutoAllow = this.sandboxAutoAllow;
    return checker;
  }

  check(
    toolName: string,
    category: "read" | "write" | "command",
    args: Record<string, unknown>,
  ): Decision {
    const content = extractContent(toolName, args);

    // Use one rule snapshot for this call, including all compound-command checks.
    let snapshot: Rule[] | null = null;
    const rules = (): Rule[] => (snapshot ??= this.ruleEngine.snapshot());
    const explicitEffect = evaluateRules(rules(), toolName, content);
    if (explicitEffect === "deny" || explicitEffect === "ask") {
      return {
        effect: explicitEffect,
        reason: `Permission rule: ${explicitEffect}`,
      };
    }

    // Layer 0: plan-mode plan-file write exception.
    // Both WriteFile and EditFile targeting the plan file are allowed so the
    // model can create and update its plan.
    if (
      this.mode === "plan" &&
      (toolName === "WriteFile" || toolName === "EditFile")
    ) {
      const path = strArg(args, "file_path", "");
      if (
        this.planFilePath &&
        canonicalPath(resolve(this.workDir, path)) ===
          canonicalPath(resolve(this.workDir, this.planFilePath)) &&
        !this.sandbox.checkDenyWrite(path)
      ) {
        return {
          effect: "allow",
          reason: "Plan file write allowed in plan mode",
        };
      }
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
      const subcommands = strArg(args, "command")
        .split(/\s*(?:&&|\|\||[;|])\s*/)
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

    // Layer 4: path sandbox (file tools only).
    const filePath = strArg(args, "file_path", strArg(args, "path", ""));
    if ((category === "read" || category === "write") && filePath) {
      // denyWrite check takes priority: sensitive paths always deny writes
      if (category === "write") {
        const denyDecision = this.sandbox.checkDenyWrite(filePath);
        if (denyDecision) {
          return denyDecision;
        }
      }
      const sandboxDecision = this.sandbox.check(filePath);
      if (sandboxDecision && this.mode !== "bypassPermissions") {
        // An explicit rule (e.g. `ReadFile(/foo/*)` allow) overrides the
        // sandbox ask; otherwise rules for outside paths could never apply.
        const ruleEffect = this.ruleEngine.evaluate(toolName, content);
        if (ruleEffect) {
          return {
            effect: ruleEffect,
            reason: `Permission rule: ${ruleEffect}`,
          };
        }
        return { effect: "ask", reason: sandboxDecision.reason };
      }
    }

    // Layer 5: rule engine — per-tool content + glob match.
    const ruleEffect = evaluateRules(rules(), toolName, content);
    if (ruleEffect) {
      return { effect: ruleEffect, reason: `Permission rule: ${ruleEffect}` };
    }

    // Layer 6: mode matrix.
    return {
      effect: modeDecide(this.mode, category),
      reason: `Mode: ${this.mode}`,
    };
  }

  // Allow an extra directory outside the project root. When a background agent
  // needs read/write access to user-level data (e.g., user-level memory dir),
  // the caller declares it explicitly; the sandbox baseline stays at the project root.
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
      const abs = resolve(this.workDir, content);
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
   * Prioritizes extracting fields defined in CONTENT_FIELDS (e.g., command, file_path);
   * falls back to a key:value summary of parameters if no match is found.
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

import { execFile } from "node:child_process";
import {
  closeSync,
  existsSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
} from "node:fs";
import {
  availableParallelism,
  arch,
  cpus,
  endianness,
  freemem,
  hostname,
  loadavg,
  machine,
  platform,
  release,
  totalmem,
  uptime as osUptime,
  userInfo,
  version as osVersion,
} from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import * as v8 from "node:v8";

import yaml from "js-yaml";

import {
  isSensitiveKey,
  redactJsonLines,
  redactJsonValue,
  redactText,
  redactUrl,
} from "./redact.js";
import type { AttachmentKind, CollectedFile } from "./types.js";

import { globalConfigPath } from "@/config/provider-config.js";
import { fileHistoryDir } from "@/file-history/index.js";
import {
  getSessionFilePath,
  loadSession,
  type SessionMessage,
  type ToolResultRecord,
} from "@/session/index.js";
import { yukinoPath } from "@/storage/paths.js";
import { version } from "@/version.js";

const execFileAsync = promisify(execFile);

export const MAX_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 20 * 1024 * 1024;
const MAX_BACKUP_FILE_BYTES = 1024 * 1024;
const MAX_TRACE_RESULT_CHARS = 100_000;
const MAX_CONFIG_FILE_BYTES = 256 * 1024;
const GIT_TIMEOUT_MS = 3_000;

/** Live process/session state handed in by the UI layer. */
export interface RuntimeInfo {
  provider?: {
    name: string;
    model: string;
    protocol?: string;
    baseUrl?: string;
    contextWindow?: number;
    maxOutputTokens?: number;
    thinkingLevel?: string;
  };
  permissionMode?: string;
  sandbox?: { enabled: boolean; autoAllow: boolean };
  mcpServers?: string[];
  toolCount?: number;
  sessionId?: string;
}

export interface CollectInput {
  cwd: string;
  sessionId: string;
  attachments: AttachmentKind[];
  runtime?: RuntimeInfo;
}

export interface CollectOutput {
  files: CollectedFile[];
  skipped: string[];
}

/**
 * Read a text file keeping at most `maxBytes` from the TAIL — session activity
 * grows by appending, so the recent failure scene survives the cap. A leading
 * partial line is dropped.
 */
export function readTextCapped(
  path: string,
  maxBytes: number,
): { content: string; truncated: boolean } {
  const size = statSync(path).size;
  if (size <= maxBytes) {
    return { content: readFileSync(path, "utf-8"), truncated: false };
  }
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(maxBytes);
    readSync(fd, buf, 0, maxBytes, size - maxBytes);
    let text = buf.toString("utf-8");
    const newline = text.indexOf("\n");
    if (newline !== -1) {
      text = text.slice(newline + 1);
    }
    return { content: text, truncated: true };
  } finally {
    closeSync(fd);
  }
}

function readCappedJsonl(path: string, name: string): CollectedFile | null {
  if (!existsSync(path)) {
    return null;
  }
  let raw: { content: string; truncated: boolean };
  try {
    raw = readTextCapped(path, MAX_FILE_BYTES);
  } catch {
    return null;
  }
  let content = redactJsonLines(raw.content);
  if (raw.truncated) {
    const marker = JSON.stringify({
      _note: `truncated: only the last ${String(MAX_FILE_BYTES)} bytes are included`,
    });
    content = `${marker}\n${content}`;
  }
  return { name, content, truncated: raw.truncated };
}

function traceResultText(content: string | Record<string, unknown>[]): string {
  const text = typeof content === "string" ? content : JSON.stringify(content);
  if (text.length > MAX_TRACE_RESULT_CHARS) {
    return `${text.slice(0, MAX_TRACE_RESULT_CHARS)}\n…[truncated]`;
  }
  return text;
}

/** Derive a tool-call trace (arguments + results) from the persisted session. */
function buildToolTrace(cwd: string, sessionId: string): string | null {
  let messages: SessionMessage[];
  try {
    messages = loadSession(cwd, sessionId);
  } catch {
    return null;
  }
  const results = new Map<string, ToolResultRecord>();
  for (const msg of messages) {
    for (const result of msg.tool_results ?? []) {
      results.set(result.tool_use_id, result);
    }
  }
  const lines: string[] = [];
  for (const msg of messages) {
    for (const use of msg.tool_uses ?? []) {
      const result = results.get(use.tool_use_id);
      const entry = {
        timestamp: msg.timestamp,
        tool: use.tool_name,
        arguments: use.arguments ?? {},
        isError: result ? (result.is_error ?? false) : null,
        result: result ? traceResultText(result.content) : null,
      };
      lines.push(JSON.stringify(redactJsonValue(entry)));
    }
  }
  return lines.length > 0 ? `${lines.join("\n")}\n` : null;
}

function decodeUtf8(buf: Buffer): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    return null;
  }
}

type AddFn = (name: string, content: string, truncated: boolean) => void;

function collectFileHistory(
  sessionId: string,
  add: AddFn,
  skipped: string[],
): void {
  const dir = fileHistoryDir(sessionId);
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    skipped.push("file-history/");
    return;
  }
  for (const entry of entries.sort()) {
    const full = join(dir, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (!st.isFile()) {
      continue;
    }
    const name = `file-history/${entry}`;
    if (st.size > MAX_BACKUP_FILE_BYTES) {
      skipped.push(name);
      continue;
    }
    let raw: Buffer;
    try {
      raw = readFileSync(full);
    } catch {
      skipped.push(name);
      continue;
    }
    const text = decodeUtf8(raw);
    if (text === null) {
      // Binary backups cannot ride along in text attachments.
      skipped.push(name);
      continue;
    }
    add(
      name,
      entry === "snapshots.json" ? redactJsonLines(text) : redactText(text),
      false,
    );
  }
}

async function collectGitInfo(
  cwd: string,
): Promise<Record<string, unknown> | null> {
  try {
    await execFileAsync("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd,
      timeout: GIT_TIMEOUT_MS,
    });
  } catch {
    return null;
  }
  const run = async (args: string[]): Promise<string | null> => {
    try {
      const { stdout } = await execFileAsync("git", args, {
        cwd,
        timeout: GIT_TIMEOUT_MS,
      });
      return stdout.trim() || null;
    } catch {
      return null;
    }
  };
  const [branch, remoteUrl, status, head, describe] = await Promise.all([
    run(["rev-parse", "--abbrev-ref", "HEAD"]),
    run(["remote", "get-url", "origin"]),
    run(["status", "--porcelain"]),
    run(["rev-parse", "HEAD"]),
    run(["describe", "--tags", "--always"]),
  ]);
  return {
    branch,
    remoteUrl: remoteUrl ? redactUrl(remoteUrl) : null,
    dirty: status !== null && status !== "",
    head,
    describe,
  };
}

// ---------------------------------------------------------------------------
// Environment snapshot
// ---------------------------------------------------------------------------

export interface EnvironmentSnapshot {
  yukino: {
    version: string;
    userAgent: string;
    pid: number;
    uptimeSeconds: number;
    argv: string[];
    execArgv: string[];
    execPath: string;
    cwd: string;
    sessionId: string | null;
  };
  runtime: {
    provider: RuntimeInfo["provider"] | null;
    permissionMode: string | null;
    sandbox: { enabled: boolean; autoAllow: boolean } | null;
    mcpServers: string[] | null;
    toolCount: number | null;
  };
  configFile: {
    path: string;
    status: "ok" | "missing" | "parse_error" | "read_error";
    yaml?: unknown;
    raw?: string;
    error?: string;
  };
  os: {
    platform: string;
    arch: string;
    machine: string | null;
    release: string;
    version: string | null;
    hostname: string;
    uptimeSeconds: number;
    totalMemoryBytes: number;
    freeMemoryBytes: number;
    loadAverage: number[];
    availableParallelism: number;
    endianness: string;
    timezone: string | null;
    locale: string | null;
    userInfo: {
      username: string;
      shell: string | null;
      homedir: string;
      uid: number;
      gid: number;
    } | null;
  };
  cpu: {
    logicalCores: number;
    model: string | null;
    speedMHz: number | null;
    cores: ReturnType<typeof cpus> | null;
  };
  node: {
    version: string;
    versions: Record<string, string | undefined>;
  };
  memory: {
    process: NodeJS.MemoryUsage;
    heapStatistics: v8.HeapInfo;
    heapSpaces: v8.HeapSpaceInfo[];
    resourceUsage: NodeJS.ResourceUsage | null;
  };
  terminal: {
    term: string | null;
    program: string | null;
    programVersion: string | null;
    colorterm: string | null;
    tmux: boolean;
    tmuxPane: string | null;
    ssh: boolean;
    ci: boolean;
    shell: string | null;
    lang: string | null;
    lcAll: string | null;
    wtSession: string | null;
    itermSession: string | null;
    kittyWindowId: string | null;
    alacrittySocket: string | null;
    vteVersion: string | null;
    noColor: string | null;
    forceColor: string | null;
    stdoutIsTTY: boolean;
    columns: number | null;
    rows: number | null;
  };
  env: {
    yukinoVars: Record<string, string>;
    proxyVars: Record<string, string>;
  };
  git: Record<string, unknown> | null;
}

const PROXY_VAR_NAMES = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
];

function envValue(name: string): string | null {
  return process.env[name] ?? null;
}

function collectYukinoVars(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of Object.keys(process.env).sort()) {
    if (!name.startsWith("YUKINO_")) {
      continue;
    }
    const value = process.env[name] ?? "";
    out[name] = isSensitiveKey(name) ? "<redacted>" : value;
  }
  return out;
}

function collectProxyVars(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of PROXY_VAR_NAMES) {
    const value = envValue(name);
    if (value !== null) {
      // Proxy URLs often embed credentials (http://user:pass@host).
      out[name] = redactUrl(value);
    }
  }
  return out;
}

function collectConfigFile(): EnvironmentSnapshot["configFile"] {
  const path = globalConfigPath();
  if (!existsSync(path)) {
    return { path, status: "missing" };
  }
  let text: string;
  try {
    text = readTextCapped(path, MAX_CONFIG_FILE_BYTES).content;
  } catch (err) {
    return {
      path,
      status: "read_error",
      error: err instanceof Error ? err.message : String(err),
    };
  }
  try {
    // api_key entries and credential-bearing URLs are stripped by the
    // key-name and URL redaction inside redactJsonValue.
    return { path, status: "ok", yaml: redactJsonValue(yaml.load(text)) };
  } catch (err) {
    return {
      path,
      status: "parse_error",
      raw: redactText(text),
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function collectUserInfo(): EnvironmentSnapshot["os"]["userInfo"] {
  try {
    const info = userInfo();
    return {
      username: info.username,
      shell: info.shell,
      homedir: info.homedir,
      uid: info.uid,
      gid: info.gid,
    };
  } catch {
    return null;
  }
}

function collectCpu(): EnvironmentSnapshot["cpu"] {
  try {
    const list = cpus();
    const first = list[0];
    return {
      logicalCores: list.length,
      model: first?.model ?? null,
      speedMHz: first?.speed ?? null,
      cores: list,
    };
  } catch {
    return { logicalCores: 0, model: null, speedMHz: null, cores: null };
  }
}

function collectResourceUsage(): NodeJS.ResourceUsage | null {
  try {
    return process.resourceUsage();
  } catch {
    return null;
  }
}

function safeMachine(): string | null {
  try {
    return machine();
  } catch {
    return null;
  }
}

function safeOsVersion(): string | null {
  try {
    return osVersion();
  } catch {
    return null;
  }
}

/**
 * Full failure-scene snapshot. Internal harness tooling: collect liberally,
 * but credentials never leave — api keys, tokens and proxy credentials are
 * redacted by key name, URL parsing and secret-format patterns.
 */
export async function buildEnvironment(
  cwd: string,
  runtime?: RuntimeInfo,
): Promise<EnvironmentSnapshot> {
  const resolved = Intl.DateTimeFormat().resolvedOptions();
  const provider = runtime?.provider;
  return {
    yukino: {
      version,
      userAgent: `yukino/${version} (${platform()}; ${arch()})`,
      pid: process.pid,
      uptimeSeconds: Math.round(process.uptime()),
      argv: process.argv,
      execArgv: process.execArgv,
      execPath: process.execPath,
      cwd,
      sessionId: runtime?.sessionId ?? null,
    },
    runtime: {
      provider: provider
        ? {
            ...provider,
            baseUrl: provider.baseUrl ? redactUrl(provider.baseUrl) : undefined,
          }
        : null,
      permissionMode: runtime?.permissionMode ?? null,
      sandbox: runtime?.sandbox ?? null,
      mcpServers: runtime?.mcpServers ?? null,
      toolCount: runtime?.toolCount ?? null,
    },
    configFile: collectConfigFile(),
    os: {
      platform: platform(),
      arch: arch(),
      machine: safeMachine(),
      release: release(),
      version: safeOsVersion(),
      hostname: hostname(),
      uptimeSeconds: Math.round(osUptime()),
      totalMemoryBytes: totalmem(),
      freeMemoryBytes: freemem(),
      loadAverage: loadavg().map((n) => Number(n.toFixed(2))),
      availableParallelism: availableParallelism(),
      endianness: endianness(),
      timezone: resolved.timeZone ?? null,
      locale: resolved.locale ?? null,
      userInfo: collectUserInfo(),
    },
    cpu: collectCpu(),
    node: {
      version: process.version,
      versions: { ...process.versions },
    },
    memory: {
      process: process.memoryUsage(),
      heapStatistics: v8.getHeapStatistics(),
      heapSpaces: v8.getHeapSpaceStatistics(),
      resourceUsage: collectResourceUsage(),
    },
    terminal: {
      term: envValue("TERM"),
      program: envValue("TERM_PROGRAM"),
      programVersion: envValue("TERM_PROGRAM_VERSION"),
      colorterm: envValue("COLORTERM"),
      tmux: Boolean(process.env.TMUX),
      tmuxPane: envValue("TMUX_PANE"),
      ssh: Boolean(
        process.env.SSH_CONNECTION ||
        process.env.SSH_CLIENT ||
        process.env.SSH_TTY,
      ),
      ci: Boolean(process.env.CI),
      shell: envValue("SHELL"),
      lang: envValue("LANG"),
      lcAll: envValue("LC_ALL"),
      wtSession: envValue("WT_SESSION"),
      itermSession: envValue("ITERM_SESSION_ID"),
      kittyWindowId: envValue("KITTY_WINDOW_ID"),
      alacrittySocket: envValue("ALACRITTY_SOCKET"),
      vteVersion: envValue("VTE_VERSION"),
      noColor: envValue("NO_COLOR"),
      forceColor: envValue("FORCE_COLOR"),
      stdoutIsTTY: process.stdout.isTTY,
      columns: process.stdout.isTTY ? (process.stdout.columns ?? null) : null,
      rows: process.stdout.isTTY ? (process.stdout.rows ?? null) : null,
    },
    env: {
      yukinoVars: collectYukinoVars(),
      proxyVars: collectProxyVars(),
    },
    git: await collectGitInfo(cwd),
  };
}

/** Compact subset embedded in issue bodies; the full snapshot rides in the attachment. */
export function summarizeEnvironment(
  env: EnvironmentSnapshot,
): Record<string, unknown> {
  return {
    yukino: env.yukino.version,
    userAgent: env.yukino.userAgent,
    platform: env.os.platform,
    arch: env.os.arch,
    machine: env.os.machine,
    osRelease: env.os.release,
    cpu: env.cpu.model,
    logicalCores: env.cpu.logicalCores,
    totalMemoryBytes: env.os.totalMemoryBytes,
    node: env.node.version,
    v8: env.node.versions.v8,
    rss: env.memory.process.rss,
    heapUsed: env.memory.process.heapUsed,
    heapTotal: env.memory.process.heapTotal,
    terminal: env.terminal.program ?? env.terminal.term,
    tmux: env.terminal.tmux,
    ssh: env.terminal.ssh,
    provider: env.runtime.provider,
    permissionMode: env.runtime.permissionMode,
    sandbox: env.runtime.sandbox,
    configStatus: env.configFile.status,
    git: env.git,
  };
}

// env and log first: they are small and the most failure-relevant context.
const COLLECT_ORDER: AttachmentKind[] = [
  "env",
  "log",
  "session",
  "tools",
  "file-history",
];

export async function collectAttachments(
  input: CollectInput,
): Promise<CollectOutput> {
  const files: CollectedFile[] = [];
  const skipped: string[] = [];
  let totalBytes = 0;
  const wanted = new Set(input.attachments);

  const add: AddFn = (name, content, truncated) => {
    if (totalBytes + content.length > MAX_TOTAL_BYTES) {
      skipped.push(name);
      return;
    }
    files.push({ name, content, truncated });
    totalBytes += content.length;
  };

  for (const kind of COLLECT_ORDER) {
    if (!wanted.has(kind)) {
      continue;
    }
    switch (kind) {
      case "env": {
        const env = await buildEnvironment(input.cwd, input.runtime);
        add("environment.json", `${JSON.stringify(env, null, 2)}\n`, false);
        break;
      }
      case "log": {
        const file = readCappedJsonl(
          yukinoPath("logs", `${input.sessionId}.jsonl`),
          "log.jsonl",
        );
        if (file) {
          add(file.name, file.content, file.truncated);
        } else {
          skipped.push("log.jsonl");
        }
        break;
      }
      case "session": {
        const file = readCappedJsonl(
          getSessionFilePath(input.cwd, input.sessionId),
          "session.jsonl",
        );
        if (file) {
          add(file.name, file.content, file.truncated);
        } else {
          skipped.push("session.jsonl");
        }
        break;
      }
      case "tools": {
        const trace = buildToolTrace(input.cwd, input.sessionId);
        if (trace) {
          add("tool-trace.jsonl", trace, false);
        } else {
          skipped.push("tool-trace.jsonl");
        }
        break;
      }
      case "file-history": {
        collectFileHistory(input.sessionId, add, skipped);
        break;
      }
    }
  }
  return { files, skipped };
}

/** Size shown next to each attachment in the dialog; null when not applicable. */
export function attachmentSizePreview(
  cwd: string,
  sessionId: string,
  kind: AttachmentKind,
): number | null {
  try {
    switch (kind) {
      case "session":
        return statSync(getSessionFilePath(cwd, sessionId)).size;
      case "log":
        return statSync(yukinoPath("logs", `${sessionId}.jsonl`)).size;
      case "file-history": {
        const dir = fileHistoryDir(sessionId);
        if (!existsSync(dir)) {
          return null;
        }
        let total = 0;
        for (const entry of readdirSync(dir)) {
          total += statSync(join(dir, entry)).size;
        }
        return total;
      }
      case "tools":
      case "env":
        return null;
    }
  } catch {
    return null;
  }
}

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  attachmentSizePreview,
  buildEnvironment,
  collectAttachments,
  readTextCapped,
  summarizeEnvironment,
} from "@/feedback/collect.js";
import { MAX_FILE_BYTES } from "@/feedback/constants.js";
import { redactText } from "@/feedback/redact.js";
import { fileHistoryDir } from "@/file-history/index.js";
import { closeLogger, initLogger } from "@/logger/index.js";
import { saveMessage } from "@/session/index.js";
import { yukinoPath } from "@/storage/index.js";
import { spillDir } from "@/tool-result/index.js";

const SESSION = "collect-test-session";

function makeProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "yukino-feedback-collect-"));
  mkdirSync(dir, { recursive: true });
  return dir;
}

function seedSession(cwd: string): void {
  saveMessage(cwd, SESSION, {
    role: "assistant",
    content: "running the command",
    timestamp: 1_700_000_000,
    tool_uses: [
      {
        tool_use_id: "t1",
        tool_name: "Bash",
        arguments: { command: "ls -la" },
      },
    ],
  });
  saveMessage(cwd, SESSION, {
    role: "user",
    content: "",
    timestamp: 1_700_000_010,
    tool_results: [
      {
        tool_use_id: "t1",
        content: "total 8\ndrwxr-xr-x  src",
        is_error: false,
      },
    ],
  });
}

describe("readTextCapped", () => {
  it("keeps the tail on line boundaries when over the cap", () => {
    const dir = makeProject();
    const path = join(dir, "big.jsonl");
    const lines: string[] = [];
    for (let i = 0; i < 100; i++) {
      lines.push(JSON.stringify({ index: i, pad: "x".repeat(1000) }));
    }
    writeFileSync(path, lines.join("\n"));
    const { content, truncated } = readTextCapped(path, 5_000);
    expect(truncated).toBe(true);
    expect(content.length).toBeLessThan(5_000);
    // Tail kept: last line present, first lines dropped, starts at a line boundary.
    expect(content).toContain('"index":99');
    expect(content).not.toContain('"index":0,');
    expect(content.startsWith("{")).toBe(true);
  });

  it("returns the whole file under the cap", () => {
    const dir = makeProject();
    const path = join(dir, "small.txt");
    writeFileSync(path, "hello\n");
    expect(readTextCapped(path, 100)).toEqual({
      content: "hello\n",
      truncated: false,
    });
  });
});

describe("buildEnvironment", () => {
  it("captures the full failure scene without any credentials", async () => {
    const env = await buildEnvironment("/tmp", {
      provider: {
        name: "anthropic",
        model: "claude-sonnet-x",
        protocol: "anthropic",
        baseUrl: "https://user:pass@api.example.com/v1",
      },
      permissionMode: "default",
      sandbox: { enabled: true, autoAllow: false },
      mcpServers: ["codegraph"],
      toolCount: 42,
      sessionId: "scene-session",
    });

    // yukino process facts
    expect(env.yukino.version).toBeTruthy();
    expect(env.yukino.userAgent).toMatch(/^yukino\/.+ \(.+; .+\)$/);
    expect(env.yukino.cwd).toBe("/tmp");
    expect(env.yukino.sessionId).toBe("scene-session");
    expect(env.yukino.argv.length).toBeGreaterThan(0);

    // runtime state
    expect(env.runtime.provider).toEqual({
      name: "anthropic",
      model: "claude-sonnet-x",
      protocol: "anthropic",
      baseUrl: "https://api.example.com/v1", // userinfo stripped
    });
    expect(env.runtime.permissionMode).toBe("default");
    expect(env.runtime.sandbox).toEqual({ enabled: true, autoAllow: false });
    expect(env.runtime.mcpServers).toEqual(["codegraph"]);
    expect(env.runtime.toolCount).toBe(42);

    // device / os / cpu / memory
    expect(env.os.platform).toBe(process.platform);
    expect(env.os.hostname).toBeTruthy();
    expect(env.os.totalMemoryBytes).toBeGreaterThan(0);
    expect(
      env.os.userInfo === null || env.os.userInfo.username.length > 0,
    ).toBe(true);
    expect(env.cpu.logicalCores).toBeGreaterThan(0);
    expect(env.cpu.cores).toBeTruthy();
    expect(env.memory.process.rss).toBeGreaterThan(0);
    expect(env.memory.heapStatistics.total_heap_size).toBeGreaterThan(0);
    expect(env.memory.heapSpaces.length).toBeGreaterThan(0);
    expect(env.node.versions.v8).toBeTruthy();

    // git info is null or an object, never throws for non-repos
    expect(env.git === null || typeof env.git === "object").toBe(true);
  });

  it("redacts api keys and credential URLs in the config file", async () => {
    mkdirSync(yukinoPath(), { recursive: true });
    writeFileSync(
      yukinoPath("config.yaml"),
      [
        "permission_mode: default",
        "providers:",
        "  - name: test-provider",
        "    protocol: anthropic",
        "    base_url: https://user:secret@api.example.com/v1",
        "    model: test-model",
        "    api_key: super-secret-key-value",
        "mcp_servers:",
        "  - name: srv",
        "    command: srv",
        "    env:",
        "      OPENAI_API_KEY: another-secret-value",
        "",
      ].join("\n"),
    );
    const env = await buildEnvironment("/tmp");
    expect(env.configFile.status).toBe("ok");
    const text = JSON.stringify(env.configFile.yaml);
    expect(text).not.toContain("super-secret-key-value");
    expect(text).not.toContain("another-secret-value");
    expect(text).not.toContain("user:secret");
    expect(text).toContain("<redacted>");
    expect(text).toContain("test-provider");
    expect(text).toContain("test-model");
  });

  it("collects YUKINO_* vars (masking sensitive names) and proxy URLs", async () => {
    vi.stubEnv("YUKINO_SCENE_TEST", "visible-value");
    vi.stubEnv("YUKINO_AUTH_TOKEN", "tok-secret-value");
    vi.stubEnv("HTTPS_PROXY", "http://user:pass@proxy.corp:8080");
    try {
      const env = await buildEnvironment("/tmp");
      expect(env.env.yukinoVars.YUKINO_SCENE_TEST).toBe("visible-value");
      expect(env.env.yukinoVars.YUKINO_AUTH_TOKEN).toBe("<redacted>");
      // URL normalization strips the credentials and appends a trailing slash.
      expect(env.env.proxyVars.HTTPS_PROXY).toBe("http://proxy.corp:8080/");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("summarizes the environment for issue bodies", async () => {
    const env = await buildEnvironment("/tmp");
    const summary = summarizeEnvironment(env);
    expect(summary.yukino).toBe(env.yukino.version);
    expect(summary.platform).toBe(env.os.platform);
    expect(summary.node).toBe(env.node.version);
    expect(summary).not.toHaveProperty("cpu");
    expect(summary).not.toHaveProperty("git");
    expect(summary).not.toHaveProperty("argv");
    expect(summary).not.toHaveProperty("heapSpaces");
  });

  it("redacts raw malformed YAML and parser error snippets", async () => {
    mkdirSync(yukinoPath(), { recursive: true });
    writeFileSync(
      yukinoPath("config.yaml"),
      "api_key: opaque-api-value\nbroken: [\n",
    );
    const env = await buildEnvironment("/tmp");
    expect(env.configFile.status).toBe("parse_error");
    expect(JSON.stringify(env)).not.toContain("opaque-api-value");
  });

  it("preserves the runtime config and raw YAML with credentials removed", async () => {
    mkdirSync(yukinoPath(), { recursive: true });
    writeFileSync(
      yukinoPath("config.yaml"),
      "enable_memory: false\napi_key: disk-key\n",
    );
    const env = await buildEnvironment("/tmp", {
      config: {
        active_provider: {
          model: "runtime-model",
          thinking_mode: "adaptive",
          api_key: "runtime-key",
        },
        hooks: [{ event: "PreToolUse", action: { command: "hook" } }],
      },
    });
    expect(env.runtime.config).toMatchObject({
      active_provider: {
        model: "runtime-model",
        thinking_mode: "adaptive",
        api_key: "<redacted>",
      },
    });
    expect(env.configFile.raw).toContain("enable_memory: false");
    expect(JSON.stringify(env)).not.toContain("disk-key");
    expect(JSON.stringify(env)).not.toContain("runtime-key");
  });
});

describe("collectAttachments", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = makeProject();
  });

  it("collects every selected group and redacts secrets", async () => {
    seedSession(cwd);
    // Log with a secret-looking token inside a message field.
    mkdirSync(yukinoPath("logs"), { recursive: true });
    writeFileSync(
      yukinoPath("logs", `${SESSION}.jsonl`),
      `${JSON.stringify({ level: 50, msg: "failed", key: "sk-ant-api03-ABCDEFGHIJKLMNOPQRST" })}\n`,
    );
    // File history: snapshots + one text backup + one binary backup.
    const fhDir = fileHistoryDir(SESSION);
    mkdirSync(fhDir, { recursive: true });
    writeFileSync(join(fhDir, "snapshots.json"), "[]\n");
    writeFileSync(join(fhDir, "backup-0.ts"), "export const x = 1;\n");
    writeFileSync(join(fhDir, "backup-1.bin"), Buffer.from([0, 1, 2, 255]));

    const out = await collectAttachments({
      cwd,
      sessionId: SESSION,
      attachments: ["env", "log", "session", "tools", "file-history"],
      runtime: { provider: { name: "anthropic", model: "claude-sonnet-x" } },
    });

    const names = out.files.map((f) => f.name);
    expect(names).toContain("environment.json");
    expect(names).toContain("log.jsonl");
    expect(names).toContain("session.jsonl");
    expect(names).toContain("tool-trace.jsonl");
    expect(names).toContain("file-history/snapshots.json");
    expect(names).toContain("file-history/backup-0.ts");
    // Binary backup must be skipped, not corrupted into text.
    expect(names).not.toContain("file-history/backup-1.bin");
    expect(out.skipped).toContain("file-history/backup-1.bin");

    const log = out.files.find((f) => f.name === "log.jsonl");
    expect(log?.content).not.toContain("sk-ant-api03");
    expect(log?.content).toContain("<redacted>");

    const trace = out.files.find((f) => f.name === "tool-trace.jsonl");
    expect(trace?.content).toContain('"tool":"Bash"');
    expect(trace?.content).toContain("ls -la");
    expect(trace?.content).toContain("drwxr-xr-x");
  });

  it("skips missing groups without failing", async () => {
    const out = await collectAttachments({
      cwd,
      sessionId: "no-such-session",
      attachments: ["session", "log", "file-history"],
    });
    expect(out.files).toEqual([]);
    expect(out.skipped).toEqual(
      expect.arrayContaining(["session.jsonl", "log.jsonl"]),
    );
  });

  it("truncates oversized session logs and marks them", async () => {
    const big = `${"x".repeat(MAX_FILE_BYTES + 1024)}\n{"tail":true}\n`;
    mkdirSync(yukinoPath("logs"), { recursive: true });
    writeFileSync(yukinoPath("logs", `${SESSION}.jsonl`), big);
    const out = await collectAttachments({
      cwd,
      sessionId: SESSION,
      attachments: ["log"],
    });
    const log = out.files.find((f) => f.name === "log.jsonl");
    expect(log?.truncated).toBe(true);
    expect(log?.content).toContain('"tail":true');
    expect(log?.content).toContain("_note");
  });

  it("collects and flushes the active process log when its ID differs from the conversation", async () => {
    const logger = initLogger({
      sessionId: "process-log-id",
      mode: "terminal",
      skipCleanup: true,
    });
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      logger.error("CURRENT_HARNESS_FAILURE");
      const out = await collectAttachments({
        cwd,
        sessionId: SESSION,
        attachments: ["log"],
      });
      expect(
        out.files.find((file) => file.name === "log.jsonl")?.content,
      ).toContain("CURRENT_HARNESS_FAILURE");
    } finally {
      closeLogger();
    }
  });

  it("includes full spilled tool output only when tools are selected and redacts configured keys", async () => {
    const dir = spillDir(SESSION);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "t1.txt"),
      "FULL_TOOL_OUTPUT\nreceived opaque-runtime-key\n",
    );
    const runtime = {
      config: { active_provider: { api_key: "opaque-runtime-key" } },
    };
    const out = await collectAttachments({
      cwd,
      sessionId: SESSION,
      attachments: ["tools"],
      runtime,
    });
    const output = out.files.find((file) => file.name === "tool-output/t1.txt");
    expect(output?.content).toContain("FULL_TOOL_OUTPUT");
    expect(output?.content).not.toContain("opaque-runtime-key");
    const without = await collectAttachments({
      cwd,
      sessionId: SESSION,
      attachments: [],
      runtime,
    });
    expect(without.files).toEqual([]);
  });

  it("keeps recent tool calls and the failure tail when the trace exceeds the cap", async () => {
    for (let index = 0; index < 65; index++) {
      saveMessage(cwd, SESSION, {
        role: "assistant",
        content: "",
        timestamp: index,
        tool_uses: [{ tool_use_id: `t${String(index)}`, tool_name: "Bash" }],
      });
      saveMessage(cwd, SESSION, {
        role: "user",
        content: "",
        timestamp: index,
        tool_results: [
          {
            tool_use_id: `t${String(index)}`,
            content: "x".repeat(110_000) + `FAILURE_${String(index)}`,
          },
        ],
      });
    }
    const out = await collectAttachments({
      cwd,
      sessionId: SESSION,
      attachments: ["tools"],
    });
    const trace = out.files.find((file) => file.name === "tool-trace.jsonl");
    expect(trace?.truncated).toBe(true);
    expect(Buffer.byteLength(trace?.content ?? "")).toBeLessThanOrEqual(
      MAX_FILE_BYTES,
    );
    expect(trace?.content).toContain("FAILURE_64");
  });

  it("prioritizes snapshot metadata over backups when file history exceeds the total cap", async () => {
    const dir = fileHistoryDir(SESSION);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "snapshots.json"), '{"snapshots":[]}\n');
    const content = "x".repeat(1024 * 1024);
    for (let index = 0; index < 21; index++) {
      writeFileSync(join(dir, `backup-${String(index)}.ts`), content);
    }
    const out = await collectAttachments({
      cwd,
      sessionId: SESSION,
      attachments: ["file-history"],
    });
    expect(out.files[0].name).toBe("file-history/snapshots.json");
    expect(out.skipped.length).toBeGreaterThan(0);
  });
});

describe("attachmentSizePreview", () => {
  it("reports sizes for file-backed kinds and null otherwise", () => {
    const cwd = makeProject();
    seedSession(cwd);
    expect(attachmentSizePreview(cwd, SESSION, "session")).toBeGreaterThan(0);
    expect(attachmentSizePreview(cwd, SESSION, "env")).toBeNull();
    expect(attachmentSizePreview(cwd, "missing-session", "session")).toBeNull();
  });
});

describe("redactText (guard for backup files)", () => {
  it("keeps source code intact while redacting embedded keys", () => {
    const src = 'const key = "sk-ant-api03-ABCDEFGHIJKLMNOPQRST";\nfoo();';
    const out = redactText(src);
    expect(out).toContain("foo();");
    expect(out).not.toContain("sk-ant-api03");
  });
});

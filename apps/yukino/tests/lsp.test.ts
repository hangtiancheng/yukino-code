import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import z from "zod";

import { LspServerConfigSchema, type LspServerConfig } from "@/lsp/config.js";
import { LspTool } from "@/tools/lsp.js";

const fixture = fileURLToPath(
  new URL("./fixtures/lsp-server.mjs", import.meta.url),
);
let cwd: string;
let logFile: string;
let tools: LspTool[];
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "yukino-lsp-"));
  logFile = join(cwd, "protocol.jsonl");
  tools = [];
  writeFileSync(join(cwd, "example.ts"), "🙂 value\nexport const value = 1;\n");
});
afterEach(async () => {
  await Promise.all(tools.map((tool) => tool.dispose()));
  rmSync(cwd, { recursive: true, force: true });
});
function tool(options: Record<string, unknown> = {}, timeout = 1000): LspTool {
  const config: LspServerConfig = {
    name: "fixture",
    command: process.execPath,
    args: [fixture, logFile],
    languages: { ".ts": "typescript" },
    initialization_options: options,
    settings: { language: { example: "configured" } },
    timeout_ms: timeout,
  };
  const result = new LspTool([config]);
  tools.push(result);
  return result;
}
function messages(): Record<string, unknown>[] {
  return readFileSync(logFile, "utf8")
    .trim()
    .split("\n")
    .map((line) => z.record(z.string(), z.unknown()).parse(JSON.parse(line)));
}
const positionArgs = { file_path: "example.ts", line: 1, character: 3 };

describe("read-only language server tool", () => {
  it("validates trusted explicit server configuration", () => {
    const base = {
      name: "typescript",
      command: "typescript-language-server",
      languages: { ".ts": "typescript" },
    };
    expect(LspServerConfigSchema.safeParse(base).success).toBe(true);
    for (const change of [
      { languages: {} },
      { languages: { ts: "typescript" } },
      { command: "" },
      { timeout_ms: 0 },
    ]) {
      expect(
        LspServerConfigSchema.safeParse({ ...base, ...change }).success,
      ).toBe(false);
    }
  });
  it("returns actionable errors without launching an unconfigured server or missing file", async () => {
    const unconfigured = new LspTool([]);
    tools.push(unconfigured);
    expect(
      (
        await unconfigured.execute(
          { cwd },
          { operation: "hover", ...positionArgs },
        )
      ).output,
    ).toContain("No LSP server configured");
    const configured = tool();
    expect(
      (
        await configured.execute(
          { cwd },
          { operation: "hover", ...positionArgs, file_path: "absent.ts" },
        )
      ).isError,
    ).toBe(true);
    expect(() => readFileSync(logFile)).toThrow();
  });
  it.each([
    "definition",
    "references",
    "hover",
    "implementation",
    "typeDefinition",
  ])(
    "supports %s with UTF-16 coordinates and fragmented UTF-8 framing",
    async (operation) => {
      const result = await tool().execute(
        { cwd },
        { operation, ...positionArgs },
      );
      expect(result.isError).toBe(false);
      expect(result.output).toContain(`textDocument/${operation}`);
      expect(JSON.parse(result.output)).toMatchObject({
        params: { position: { line: 0, character: 2 } },
        document: { version: 1, text: "🙂 value\nexport const value = 1;\n" },
      });
    },
  );
  it("queries document and workspace symbols without requiring cursor coordinates", async () => {
    const lsp = tool();
    expect(
      (
        await lsp.execute(
          { cwd },
          { operation: "documentSymbol", file_path: "example.ts" },
        )
      ).isError,
    ).toBe(false);
    expect(
      (
        await lsp.execute(
          { cwd },
          {
            operation: "workspaceSymbol",
            file_path: "example.ts",
            query: "value",
          },
        )
      ).output,
    ).toContain("workspace/symbol");
  });
  it("preserves call hierarchy item data for both directions", async () => {
    const lsp = tool();
    for (const operation of ["incomingCalls", "outgoingCalls"]) {
      const result = await lsp.execute({ cwd }, { operation, ...positionArgs });
      expect(result.isError).toBe(false);
      expect(result.output).toContain(`callHierarchy/${operation}`);
      expect(result.output).toContain("preserved");
    }
  });
  it("shares lazy initialization but serializes document sync across simultaneous callers", async () => {
    const lsp = tool({ delay: 30 });
    const results = await Promise.all(
      ["hover", "definition"].map((operation) =>
        lsp.execute({ cwd }, { operation, ...positionArgs }),
      ),
    );
    expect(results.every((result) => !result.isError)).toBe(true);
    writeFileSync(join(cwd, "example.ts"), "changed\n");
    const changed = await lsp.execute(
      { cwd },
      { operation: "hover", ...positionArgs },
    );
    expect(JSON.parse(changed.output)).toMatchObject({
      document: { version: 2, text: "changed\n" },
    });
    expect(
      messages().filter((message) => message.method === "initialize"),
    ).toHaveLength(1);
    expect(
      messages().filter((message) => message.method === "textDocument/didOpen"),
    ).toHaveLength(1);
    expect(
      messages().filter(
        (message) => message.method === "textDocument/didChange",
      ),
    ).toHaveLength(1);
  });
  it("rejects server-requested edits while responding to workspace settings requests", async () => {
    const lsp = tool();
    const result = await lsp.execute(
      { cwd },
      { operation: "hover", ...positionArgs },
    );
    expect(result.isError).toBe(false);
    await lsp.dispose();
    expect(
      messages().find(
        (message) => message.id === "server-edit" && message.result,
      ),
    ).toMatchObject({ result: { applied: false } });
    expect(
      messages().find(
        (message) => message.id === "server-config" && message.result,
      ),
    ).toMatchObject({ result: ["configured"] });
  });
  it("ignores stale diagnostics and distinguishes pending diagnostics from a clean report", async () => {
    const result = await tool().execute(
      { cwd },
      { operation: "diagnostics", file_path: "example.ts" },
    );
    expect(result.isError).toBe(false);
    expect(result.output).toContain("current diagnostic🙂");
    expect(result.output).not.toContain("stale");
    expect(result.output).toContain('"pending": false');
    const pending = await tool({ silent: true }, 100).execute(
      { cwd },
      { operation: "diagnostics", file_path: "example.ts" },
    );
    expect(pending.output).toContain('"pending": true');
    const pull = await tool({ pull: true }).execute(
      { cwd },
      { operation: "diagnostics", file_path: "example.ts" },
    );
    expect(pull.output).toContain("pull diagnostic");
  });
  it("validates required coordinates and document boundaries", async () => {
    const lsp = tool();
    for (const args of [
      { operation: "hover", file_path: "example.ts" },
      { operation: "workspaceSymbol", file_path: "example.ts", query: " " },
      { operation: "hover", ...positionArgs, line: 0 },
      { operation: "hover", ...positionArgs, line: 100 },
      { operation: "hover", ...positionArgs, character: 100 },
    ]) {
      expect((await lsp.execute({ cwd }, args)).isError).toBe(true);
    }
  });
  it("cancels a hung request and keeps the server usable", async () => {
    const lsp = tool();
    await lsp.execute({ cwd }, { operation: "hover", ...positionArgs });
    const controller = new AbortController();
    const request = lsp.execute(
      { cwd, abortSignal: controller.signal },
      { operation: "workspaceSymbol", file_path: "example.ts", query: "hang" },
    );
    setTimeout(() => {
      controller.abort();
    }, 50);
    expect((await request).isError).toBe(true);
    expect(
      (await lsp.execute({ cwd }, { operation: "hover", ...positionArgs }))
        .isError,
    ).toBe(false);
    expect(
      messages().some((message) => message.method === "$/cancelRequest"),
    ).toBe(true);
  });
  it("timeouts are bounded and cancelled initialization does not poison concurrent callers", async () => {
    const lsp = tool({ delay: 60 }, 4000);
    const controller = new AbortController();
    const first = lsp.execute(
      { cwd, abortSignal: controller.signal },
      { operation: "hover", ...positionArgs },
    );
    const second = lsp.execute(
      { cwd },
      { operation: "hover", ...positionArgs },
    );
    controller.abort();
    expect((await first).isError).toBe(true);
    expect((await second).isError).toBe(false);
    expect(
      (
        await lsp.execute(
          { cwd },
          {
            operation: "workspaceSymbol",
            file_path: "example.ts",
            query: "hang",
          },
        )
      ).output,
    ).toContain("timed out");
  });
  it("fails malformed framing safely and can restart exited servers", async () => {
    const lsp = tool();
    const bad = await lsp.execute(
      { cwd },
      {
        operation: "workspaceSymbol",
        file_path: "example.ts",
        query: "bad-frame",
      },
    );
    expect(bad.isError).toBe(true);
    expect(bad.output).toContain("exceeds 16MB");
    expect(
      (await lsp.execute({ cwd }, { operation: "hover", ...positionArgs }))
        .isError,
    ).toBe(false);
    expect(
      (
        await lsp.execute(
          { cwd },
          {
            operation: "workspaceSymbol",
            file_path: "example.ts",
            query: "crash",
          },
        )
      ).isError,
    ).toBe(true);
    expect(
      (await lsp.execute({ cwd }, { operation: "hover", ...positionArgs }))
        .isError,
    ).toBe(false);
  });
  it("rejects incompatible position encodings and shuts servers down on disposal", async () => {
    const incompatible = await tool({ encoding: "utf-8" }).execute(
      { cwd },
      { operation: "hover", ...positionArgs },
    );
    expect(incompatible.output).toContain("Only UTF-16");
    const lsp = tool();
    await lsp.execute({ cwd }, { operation: "hover", ...positionArgs });
    await lsp.dispose();
    expect(messages().some((message) => message.method === "shutdown")).toBe(
      true,
    );
    expect(messages().some((message) => message.method === "exit")).toBe(true);
    expect(
      (await lsp.execute({ cwd }, { operation: "hover", ...positionArgs }))
        .output,
    ).toContain("disposed");
  });
  it("shares one replacement server when concurrent callers restart a crashed server", async () => {
    const lsp = tool();
    const crashed = await lsp.execute(
      { cwd },
      {
        operation: "workspaceSymbol",
        file_path: "example.ts",
        query: "crash",
      },
    );
    expect(crashed.isError).toBe(true);
    const recovered = await Promise.all(
      ["hover", "definition", "references"].map((operation) =>
        lsp.execute({ cwd }, { operation, ...positionArgs }),
      ),
    );
    expect(recovered.every((result) => !result.isError)).toBe(true);
    await lsp.dispose();
    expect(
      messages().filter((message) => message.method === "initialize"),
    ).toHaveLength(2);
    expect(
      messages().filter((message) => message.method === "shutdown"),
    ).toHaveLength(1);
  });
});

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ProviderConfig } from "@/config/provider-config.js";
import type { LLMClient } from "@/llm/client.js";
import { MCPManager } from "@/mcp/manager.js";
import { createAgentRuntime } from "@/runtime/factory.js";
import { sessionTransferCommand } from "@/session/actions.js";
import {
  LOCAL_DIAGNOSTICS_MAX_BYTES,
  LOCAL_DIAGNOSTICS_MAX_ITEMS,
} from "@/session/constants.js";
import { SessionManager } from "@/session/manager.js";
import {
  createSessionHeader,
  validateDocument,
  type SessionRecord,
} from "@/session/records.js";
import {
  buildLocalDiagnostics,
  projectRuntimeDiagnostics,
} from "@/session/transfer.js";
import type { Question } from "@/tools/ask-user.js";

const provider: ProviderConfig = {
  name: "local",
  protocol: "openai-compat",
  model: "local",
  thinking: "off",
  base_url: "https://user:URL_SECRET@invalid.example/?token=QUERY_SECRET",
  api_key: "BARE_PROVIDER_SECRET",
  headers: { "X-Private": "BARE_HEADER_SECRET" },
  env: { PRIVATE: "BARE_ENV_SECRET" },
  command: "EXECUTABLE_CONFIG_SECRET",
};
function cwd(): string {
  const home = process.env.YUKINO_TEST_HOME ?? "";
  vi.stubEnv("HOME", home);
  const path = join(home, "project");
  mkdirSync(path, { recursive: true });
  return path;
}
async function fixture() {
  const path = cwd();
  const manager = SessionManager.create(path, { persist: false });
  manager.append({
    role: "user",
    content: "UNIQUE_TRANSCRIPT token=TRANSCRIPT_SECRET /Users/me/private/file",
  });
  const stream = vi.fn(() => {
    throw new Error("No model/network is permitted");
  });
  const client: LLMClient = { stream, setSystemPrompt: vi.fn() };
  const runtime = await createAgentRuntime({
    provider,
    client,
    cwd: path,
    sessionId: manager.id,
    persist: false,
    enableCoordinatorMode: false,
    memoryEnabled: false,
    loadProjectResources: false,
  });
  return { manager, runtime, stream, path };
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("bounded local diagnostics and explicit save preview", () => {
  it("projects effective configuration, context, MCP, usage and cache without secret-bearing runtime objects", async () => {
    const { runtime, manager, stream } = await fixture();
    try {
      const mcp = new MCPManager();
      runtime.mcpManager = mcp;
      const source = mcp.createSource(
        "runtime",
        "BARE_SOURCE_OWNER_SECRET",
        "/Users/private/project",
      );
      const state = {
        name: "local-mcp",
        source,
        state: "error" as const,
        exposure: "deferred" as const,
        tools: 0,
        unreachableCodeMode: false,
        diagnostic: {
          serverName: "local-mcp",
          transport: "http" as const,
          phase: "connect" as const,
          httpStatus: 401,
          code: "AUTH",
          message: "Bearer MCP_SECRET",
        },
        configuration: provider,
        headers: { private: "BARE_MCP_SECRET" },
      };
      vi.spyOn(mcp, "states").mockReturnValue([state]);
      const status = runtime.getStatus();
      const extended = {
        ...status,
        request: {
          runId: "run",
          sessionId: manager.id,
          model: "local",
          contextWindow: 1000,
          startedAt: 1,
          observedAt: 2,
          usage: { inputTokens: 12, outputTokens: 3 },
          usageComplete: true,
          inputTotalTokens: 12,
          cachePrefixTokens: 0,
          contextTokens: 15,
          headers: { private: "BARE_USAGE_SECRET" },
        },
        cache: {
          ...status.cache,
          identity: "BARE_CACHE_IDENTITY_SECRET",
          configuration: provider,
        },
        headers: { private: "BARE_STATUS_SECRET" },
      };
      vi.spyOn(runtime, "getStatus").mockReturnValue(extended);
      const text = manager.diagnostics(projectRuntimeDiagnostics(runtime));
      expect(text).toContain(
        '"source": "runtime (effective provider; originating file not retained)"',
      );
      expect(text).toContain('"schemaGeneration"');
      expect(text).toContain('"httpStatus": 401');
      expect(text).toContain('"inputTokens": 12');
      expect(text).toContain('"warmingMode"');
      expect(text).toContain('"notNewSpending": true');
      expect(text).toContain('"node"');
      expect(text).toContain('"terminal"');
      expect(text).not.toMatch(
        /BARE_|URL_SECRET|QUERY_SECRET|MCP_SECRET|UNIQUE_TRANSCRIPT|\/Users\/private/u,
      );
      expect(text).not.toMatch(/headers|api_key|base_url|command|transcript/u);
      expect(Buffer.byteLength(text)).toBeLessThanOrEqual(
        LOCAL_DIAGNOSTICS_MAX_BYTES,
      );
      expect(stream).not.toHaveBeenCalled();
    } finally {
      await runtime.dispose();
    }
  });

  it("bounds hostile unknown diagnostics and large opt-in transcripts, redacting numeric secrets and attachments", () => {
    cwd();
    const records: SessionRecord[] = Array.from(
      { length: LOCAL_DIAGNOSTICS_MAX_ITEMS + 10 },
      (_, index) => ({
        type: "message",
        entryId: `e${index}`,
        parentId: index ? `e${index - 1}` : null,
        revision: index + 1,
        timestamp: 1,
        message: {
          role: "user",
          content: [
            {
              type: "text",
              text: `token=PRIVATE_TOKEN ${"雪".repeat(20_000)}`,
            },
            {
              type: "image",
              source: { type: "base64", media_type: "image/png", data: "QUJD" },
            },
          ],
          timestamp: 1,
        },
      }),
    );
    records.push({
      type: "active_leaf",
      leafId: `e${LOCAL_DIAGNOSTICS_MAX_ITEMS + 9}`,
      revision: records.length + 1,
    });
    const document = validateDocument(createSessionHeader(), records);
    const getter = vi.fn(() => "GETTER_SECRET");
    const errors = Object.defineProperty(
      {
        password: 123456789,
        token: "BARE_SECRET",
        message: "Bearer TEXT_SECRET",
        location: "/Users/me/private",
        huge: "\u0000".repeat(1_000_000),
      },
      "getter",
      { enumerable: true, get: getter },
    );
    const diagnostics = buildLocalDiagnostics(document, {
      errors,
      configuration: {
        model: "local",
        apiKey: "CONFIG_SECRET",
        command: "CONFIG_EXECUTABLE",
      },
      includeTranscript: true,
    });
    expect(() => {
      const parsed: unknown = JSON.parse(diagnostics);
      return parsed;
    }).not.toThrow();
    expect(Buffer.byteLength(diagnostics)).toBeLessThanOrEqual(
      LOCAL_DIAGNOSTICS_MAX_BYTES,
    );
    expect(diagnostics).not.toMatch(
      /PRIVATE_TOKEN|QUJD|123456789|BARE_SECRET|TEXT_SECRET|GETTER_SECRET|CONFIG_SECRET|CONFIG_EXECUTABLE|\/Users\/me/u,
    );
    expect(diagnostics).toContain("[REDACTED]");
    expect(diagnostics).toContain("transcript");
    expect(diagnostics).toContain("truncated");
    expect(getter).not.toHaveBeenCalled();
    expect(buildLocalDiagnostics(document)).not.toContain("transcript");
  });

  it("shows the full actual redacted preview without a model call and requires save approval even for a new file", async () => {
    const { runtime, manager, stream, path } = await fixture();
    const ask = vi.fn((questions: Question[]) =>
      Promise.resolve({ [questions[0].question]: "cancel" }),
    );
    const permission = vi.fn().mockResolvedValue("allow");
    const write = runtime.registry.get("WriteFile");
    if (!write) {
      throw new Error("Missing WriteFile");
    }
    const writes = vi.spyOn(write, "execute");
    try {
      const preview = await sessionTransferCommand(
        "diagnostics",
        "",
        runtime,
        manager,
        ask,
        permission,
      );
      expect(preview.message).toContain('"configuration"');
      expect(preview.message).not.toContain("transcript");
      expect(ask).not.toHaveBeenCalled();
      const destination = join(path, "diagnostics.json");
      const canceled = await sessionTransferCommand(
        "diagnostics",
        "diagnostics.json",
        runtime,
        manager,
        ask,
        permission,
      );
      expect(canceled.message).toContain("canceled");
      expect(ask.mock.calls[0][0][0].question).toContain('"configuration"');
      expect(ask.mock.calls[0][0][0].question).not.toContain(
        "UNIQUE_TRANSCRIPT",
      );
      expect(existsSync(destination)).toBe(false);
      expect(writes).not.toHaveBeenCalled();
      expect(permission).not.toHaveBeenCalled();
      ask.mockImplementation((questions) =>
        Promise.resolve({ [questions[0].question]: "save" }),
      );
      await sessionTransferCommand(
        "diagnostics",
        "diagnostics.json --include-transcript",
        runtime,
        manager,
        ask,
        permission,
      );
      const saved = readFileSync(destination, "utf8");
      const question = ask.mock.calls.at(-1)?.[0][0].question;
      expect(question).toContain(saved);
      expect(saved).toContain("UNIQUE_TRANSCRIPT");
      expect(saved).not.toContain("TRANSCRIPT_SECRET");
      expect(saved).not.toContain("/Users/me");
      expect(writes).toHaveBeenCalledOnce();
      expect(stream).not.toHaveBeenCalled();
      await expect(
        sessionTransferCommand(
          "diagnostics",
          "--html",
          runtime,
          manager,
          ask,
          permission,
        ),
      ).rejects.toThrow("Usage: /diagnostics");
    } finally {
      await runtime.dispose();
    }
  });

  it("keeps existing diagnostics untouched unless both preview-save and overwrite are explicitly approved", async () => {
    const { runtime, manager, path } = await fixture();
    const destination = join(path, "keep.json");
    writeFileSync(destination, "preserve existing bytes");
    const permission = vi.fn().mockResolvedValue("allow");
    const ask = vi.fn((questions: Question[]) =>
      Promise.resolve({
        [questions[0].question]: questions[0].question.startsWith("Save")
          ? "save"
          : "cancel",
      }),
    );
    try {
      await expect(
        sessionTransferCommand(
          "diagnostics",
          "keep.json",
          runtime,
          manager,
          ask,
          permission,
        ),
      ).rejects.toThrow("Overwrite canceled");
      expect(ask).toHaveBeenCalledTimes(2);
      expect(readFileSync(destination, "utf8")).toBe("preserve existing bytes");
      expect(permission).not.toHaveBeenCalled();
    } finally {
      await runtime.dispose();
    }
  });
});

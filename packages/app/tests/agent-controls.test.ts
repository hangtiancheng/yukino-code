import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import { join } from "node:path";
import { after, before, mock, test } from "node:test";

import { controlAgent, snapshotAgent } from "@main/agent-controls.ts";
import type { AgentControl } from "@shared/agent-types.ts";
import {
  createAgentSession,
  type AgentSession,
  type LLMClient,
  type StreamEvent,
} from "@yukino.js/yukino";

let fixture: string;
const sessions: AgentSession[] = [];
before(async () => {
  fixture = await mkdtemp(join(os.tmpdir(), "yukino-app-agent-"));
  mock.method(os, "homedir", () => fixture);
  syncBuiltinESMExports();
});
after(async () => {
  await Promise.all(sessions.map((session) => session.dispose()));
  mock.restoreAll();
  syncBuiltinESMExports();
  await rm(fixture, { recursive: true, force: true });
});
const client: LLMClient = {
  setSystemPrompt() {},
  async *stream(): AsyncGenerator<StreamEvent> {
    yield { type: "text_delta", text: "Desktop response" };
    yield {
      type: "stream_end",
      stopReason: "end_turn",
      usage: {
        inputTokens: 1,
        outputTokens: 1,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      },
    };
  },
};
async function create() {
  const cwd = join(fixture, `project-${sessions.length}`);
  await mkdir(cwd);
  const configPath = join(cwd, "config.yaml");
  await writeFile(
    configPath,
    "providers:\n  - name: Desktop\n    protocol: anthropic\n    base_url: https://unused.example\n    api_key: private-fixture-key\n    model: test\n",
  );
  const { session } = await createAgentSession({
    cwd,
    configPath,
    client,
    tools: [],
    persist: false,
    trust: "deny",
  });
  sessions.push(session);
  return { session, configPath };
}
const authorize = async (): Promise<void> => {
  throw new Error("Unexpected OAuth navigation");
};

void test("desktop preferences round-trip through the live SDK, survive reload and preserve provider credentials", async () => {
  const { session, configPath } = await create();
  await controlAgent(
    session,
    {
      type: "settings",
      patch: {
        code_mode: { mode: "only", inline_budget: 500 },
        display: { show_thinking: false },
      },
      persist: true,
    },
    authorize,
  );
  await controlAgent(
    session,
    {
      type: "settings",
      patch: { display: { expanded_tools: true } },
      persist: false,
    },
    authorize,
  );
  await controlAgent(session, { type: "reload" }, authorize);
  const state = snapshotAgent(session);
  assert.equal(state.preferences.values.code_mode.mode, "only");
  assert.equal(state.preferences.values.code_mode.inline_budget, 500);
  assert.equal(state.preferences.values.display.show_thinking, false);
  assert.equal(state.preferences.values.display.expanded_tools, true);
  assert.equal(JSON.stringify(state).includes("private-fixture-key"), false);
  const saved = await readFile(configPath, "utf8");
  assert.match(saved, /private-fixture-key/);
  assert.match(saved, /show_thinking: false/);
  assert.doesNotMatch(saved, /expanded_tools: true/);
});

void test("session metadata and branch labels use SDK storage and snapshots identify the active branch", async () => {
  const { session } = await create();
  await session.prompt("First question");
  const first = snapshotAgent(session).entries.find(
    (entry) => entry.role === "user",
  );
  assert.ok(first);
  await controlAgent(
    session,
    { type: "metadata", metadata: { name: "Desktop task", tags: ["review"] } },
    authorize,
  );
  await controlAgent(
    session,
    { type: "label", entryId: first.id, label: "Starting point" },
    authorize,
  );
  await session.prompt("Second question");
  const result = await controlAgent(
    session,
    { type: "navigate", entryId: first.id },
    authorize,
  );
  assert.equal(typeof result, "object");
  const state = snapshotAgent(session);
  assert.equal(state.metadata.name, "Desktop task");
  assert.equal(
    state.entries.find((entry) => entry.id === first.id)?.label,
    "Starting point",
  );
  assert.equal(
    state.entries.some(
      (entry) => entry.text === "Second question" && !entry.active,
    ),
    true,
  );
});

void test("IPC rejects malformed controls before mutating the SDK", async () => {
  const { session } = await create();
  for (const input of [
    { type: "auto_retry", enabled: "false" },
    {
      type: "settings",
      patch: { shellCommandPrefix: "unrequested" },
      persist: true,
    },
    { type: "cycle_model", direction: 0 },
    { type: "abort", scope: "invalid" },
    { type: "queue_mode", kind: "steer", mode: "invalid" },
    { type: "navigate", entryId: 1 },
    { type: "mcp_exposure", server: "test", exposure: "public" },
    { type: "reload", injected: true },
  ]) {
    await assert.rejects(
      controlAgent(session, input as AgentControl, authorize),
    );
  }
  assert.equal(session.getSettings().values.auto_retry, true);
  assert.equal(session.getQueue().length, 0);
});

import assert from "node:assert/strict";
import { test } from "node:test";

import type { Remote } from "@yukino.js/yukino";

import { applyRuntimeAction } from "../src/main/agent-runtime.ts";
import type { RuntimeAction } from "../src/shared/workspace-types.ts";

interface RuntimeControls {
  assertIdle: () => void;
  reloadMcp: () => Promise<void>;
  setSandbox: (mode: "auto" | "manual" | "off") => Promise<void>;
}

function fixture(busy = false) {
  const events: string[] = [];
  let goal: { status: string } | null = { status: "active" };
  const handle = {
    goalManager: {
      get: () => goal,
      transition: (status: string) => {
        goal = { status };
      },
      clear: () => {
        goal = null;
      },
    },
    backgroundTaskManager: {
      stop: (id: string) => {
        events.push(id);
        return id === "running";
      },
    },
    teamManager: {
      get: (team: string) =>
        team === "release"
          ? {
              stopMember: async (name: string) => {
                events.push(name);
              },
            }
          : undefined,
    },
    skillCatalog: {
      reload: () => {
        events.push("skills");
      },
    },
  };
  const controls: RuntimeControls = {
    assertIdle: () => {
      if (busy) {
        throw new Error("busy");
      }
    },
    reloadMcp: async () => {
      events.push("mcp");
    },
    setSandbox: async (mode) => {
      events.push(mode);
    },
  };
  return { handle, controls, events };
}

function run(
  handle: ReturnType<typeof fixture>["handle"],
  action: RuntimeAction,
  controls: RuntimeControls,
): Promise<void> {
  return applyRuntimeAction(
    handle as unknown as Remote.Server.RemoteAgentHandle,
    action,
    controls,
  );
}

function invalid(action: Record<string, unknown>): RuntimeAction {
  return action as unknown as RuntimeAction;
}

void test("pausing an active goal during a run prevents continuation without aborting other work", async () => {
  const { handle, controls, events } = fixture(true);
  await run(handle, { type: "pause_goal" }, controls);
  assert.equal(handle.goalManager.get()?.status, "paused");
  assert.deepEqual(events, []);
  await assert.rejects(
    run(handle, { type: "pause_goal" }, controls),
    /There is no active goal/,
  );
});

void test("background cancellation remains available during generation and rejects stale task ids", async () => {
  const { handle, controls, events } = fixture(true);
  await run(handle, { type: "stop_task", id: "running" }, controls);
  assert.deepEqual(events, ["running"]);
  await assert.rejects(
    run(handle, { type: "stop_task", id: "finished" }, controls),
    /The task has finished or does not exist/,
  );
  await run(
    handle,
    { type: "stop_teammate", team: "release", name: "tester" },
    controls,
  );
  assert.equal(events.at(-1), "tester");
  await assert.rejects(
    run(
      handle,
      { type: "stop_teammate", team: "absent", name: "tester" },
      controls,
    ),
    /The team does not exist/,
  );
});

void test("environment mutations and goal clearing are rejected while a run is active", async () => {
  const { handle, controls, events } = fixture(true);
  for (const action of [
    { type: "reload_mcp" },
    { type: "reload_skills" },
    { type: "sandbox", mode: "auto" },
    { type: "clear_goal" },
  ] satisfies RuntimeAction[]) {
    await assert.rejects(run(handle, action, controls), /busy/);
  }
  assert.equal(handle.goalManager.get()?.status, "active");
  assert.deepEqual(events, []);
});

void test("idle environment actions await completion and reject unknown operations or sandbox modes", async () => {
  const { handle, controls, events } = fixture();
  await run(handle, { type: "reload_mcp" }, controls);
  await run(handle, { type: "reload_skills" }, controls);
  await run(handle, { type: "sandbox", mode: "auto" }, controls);
  assert.deepEqual(events, ["mcp", "skills", "auto"]);
  await assert.rejects(
    run(handle, invalid({ type: "sandbox", mode: "invalid" }), controls),
    /Invalid sandbox mode/,
  );
  await assert.rejects(
    run(handle, invalid({ type: "unknown" }), controls),
    /Invalid workbench action/,
  );
  assert.deepEqual(events, ["mcp", "skills", "auto"]);
});

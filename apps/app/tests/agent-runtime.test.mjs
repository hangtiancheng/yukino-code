import assert from "node:assert/strict";
import { test } from "node:test";

import { applyRuntimeAction } from "../src/main/agent-runtime.ts";

function fixture(busy = false) {
  const events = [];
  let goal = { status: "active" };
  const handle = {
    goalManager: {
      get: () => goal,
      transition: (status) => {
        goal = { status };
      },
      clear: () => {
        goal = null;
      },
    },
    backgroundTaskManager: {
      stop: (id) => {
        events.push(id);
        return id === "running";
      },
    },
    teamManager: {
      get: (team) =>
        team === "release"
          ? {
              stopMember: async (name) => {
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
  const controls = {
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

test("pausing an active goal during a run prevents continuation without aborting other work", async () => {
  const { handle, controls, events } = fixture(true);
  await applyRuntimeAction(handle, { type: "pause_goal" }, controls);
  assert.equal(handle.goalManager.get().status, "paused");
  assert.deepEqual(events, []);
  await assert.rejects(
    applyRuntimeAction(handle, { type: "pause_goal" }, controls),
    /没有正在进行的目标/,
  );
});

test("background cancellation remains available during generation and rejects stale task ids", async () => {
  const { handle, controls, events } = fixture(true);
  await applyRuntimeAction(
    handle,
    { type: "stop_task", id: "running" },
    controls,
  );
  assert.deepEqual(events, ["running"]);
  await assert.rejects(
    applyRuntimeAction(handle, { type: "stop_task", id: "finished" }, controls),
    /任务已结束或不存在/,
  );
  await applyRuntimeAction(
    handle,
    { type: "stop_teammate", team: "release", name: "tester" },
    controls,
  );
  assert.equal(events.at(-1), "tester");
  await assert.rejects(
    applyRuntimeAction(
      handle,
      { type: "stop_teammate", team: "absent", name: "tester" },
      controls,
    ),
    /团队不存在/,
  );
});

test("environment mutations and goal clearing are rejected while a run is active", async () => {
  const { handle, controls, events } = fixture(true);
  for (const action of [
    { type: "reload_mcp" },
    { type: "reload_skills" },
    { type: "sandbox", mode: "auto" },
    { type: "clear_goal" },
  ]) {
    await assert.rejects(applyRuntimeAction(handle, action, controls), /busy/);
  }
  assert.equal(handle.goalManager.get().status, "active");
  assert.deepEqual(events, []);
});

test("idle environment actions await completion and reject unknown operations or sandbox modes", async () => {
  const { handle, controls, events } = fixture();
  await applyRuntimeAction(handle, { type: "reload_mcp" }, controls);
  await applyRuntimeAction(handle, { type: "reload_skills" }, controls);
  await applyRuntimeAction(handle, { type: "sandbox", mode: "auto" }, controls);
  assert.deepEqual(events, ["mcp", "skills", "auto"]);
  await assert.rejects(
    applyRuntimeAction(handle, { type: "sandbox", mode: "invalid" }, controls),
    /无效的沙箱模式/,
  );
  await assert.rejects(
    applyRuntimeAction(handle, { type: "unknown" }, controls),
    /无效的工作台操作/,
  );
  assert.deepEqual(events, ["mcp", "skills", "auto"]);
});

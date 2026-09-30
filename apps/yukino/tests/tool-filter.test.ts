import { describe, it, expect } from "vitest";

import {
  cloneRegistryForFork,
  filterToolsForAgent,
  MAIN_AGENT_ONLY_TOOLS,
  SUBAGENT_DISALLOWED_TOOLS,
} from "@/subagent/tool-filter.js";
import { ToolRegistry } from "@/tools/registry.js";
import type { Tool } from "@/tools/types.js";

const stub = (name: string): Tool => ({
  name,
  description: name,
  category: "read",
  schema: () => ({
    name,
    description: name,
    input_schema: { type: "object", properties: {} },
  }),
  execute: () => Promise.resolve({ output: "", isError: false }),
});

function buildRegistry(names: string[]): ToolRegistry {
  const registry = new ToolRegistry();
  for (const name of names) {
    registry.register(stub(name));
  }
  return registry;
}

const ALL = [
  "ComputerUse",
  "AskUserQuestion",
  "ExitPlanMode",
  "TaskStop",
  "Agent",
  "ReadFile",
  "Bash",
];

describe("main-agent-only tool policy", () => {
  it("keeps MAIN_AGENT_ONLY_TOOLS inside the subagent disallow list", () => {
    for (const name of MAIN_AGENT_ONLY_TOOLS) {
      expect(SUBAGENT_DISALLOWED_TOOLS.has(name)).toBe(true);
    }
  });

  it("strips every main-agent-only tool from forks, but keeps TaskStop and Agent", () => {
    const forked = cloneRegistryForFork(buildRegistry(ALL));
    const names = new Set(forked.listTools().map((t) => t.name));

    for (const name of ["ComputerUse", "AskUserQuestion", "ExitPlanMode"]) {
      expect(names.has(name)).toBe(false);
    }
    // A fork is the leader's own extension: coordination (TaskStop) and delegation
    // (Agent, re-tagged as a fork) stay available; only the main-thread-only set
    // is stripped.
    for (const name of ["TaskStop", "Agent", "ReadFile", "Bash"]) {
      expect(names.has(name)).toBe(true);
    }
  });

  it("strips main-agent-only tools plus Agent and TaskStop from defined subagents", () => {
    const filtered = filterToolsForAgent(
      buildRegistry(ALL),
      ["*"],
      undefined,
      false,
    );
    const names = new Set(filtered.listTools().map((t) => t.name));

    for (const name of [
      "ComputerUse",
      "AskUserQuestion",
      "ExitPlanMode",
      "Agent",
      "TaskStop",
    ]) {
      expect(names.has(name)).toBe(false);
    }
    for (const name of ["ReadFile", "Bash"]) {
      expect(names.has(name)).toBe(true);
    }
  });

  it("keeps Bash available to asynchronous agents", () => {
    const filtered = filterToolsForAgent(
      buildRegistry(["Bash"]),
      ["*"],
      undefined,
      true,
    );
    expect(filtered.get("Bash")).toBeDefined();
  });
});

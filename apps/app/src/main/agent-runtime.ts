import type { Remote } from "@yukino.js/yukino";

import type { RuntimeAction } from "../shared/workspace-types";

interface RuntimeControls {
  assertIdle: () => void;
  reloadMcp: () => Promise<void>;
  setSandbox: (mode: "auto" | "manual" | "off") => Promise<void>;
}

export async function applyRuntimeAction(
  handle: Remote.Server.RemoteAgentHandle,
  action: RuntimeAction,
  controls: RuntimeControls,
): Promise<void> {
  switch (action.type) {
    case "stop_task":
      if (!handle.backgroundTaskManager.stop(action.id)) {
        throw new Error("任务已结束或不存在");
      }
      return;
    case "stop_teammate": {
      const team = handle.teamManager.get(action.team);
      if (!team) {
        throw new Error("团队不存在");
      }
      await team.stopMember(action.name);
      return;
    }
    case "pause_goal":
      if (handle.goalManager?.get()?.status !== "active") {
        throw new Error("没有正在进行的目标");
      }
      handle.goalManager.transition("paused");
      return;
    case "clear_goal":
      controls.assertIdle();
      handle.goalManager?.clear();
      return;
    case "reload_skills":
      controls.assertIdle();
      handle.skillCatalog?.reload();
      return;
    case "reload_mcp":
      controls.assertIdle();
      await controls.reloadMcp();
      return;
    case "sandbox":
      controls.assertIdle();
      if (!["auto", "manual", "off"].includes(action.mode)) {
        throw new Error("无效的沙箱模式");
      }
      await controls.setSandbox(action.mode);
      return;
    default:
      throw new Error("无效的工作台操作");
  }
}

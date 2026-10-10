import type { RemoteAgentHandle } from "./server.js";

import { RecoveryState } from "@/compact/recovery.js";
import { FileHistory } from "@/file-history/index.js";
import { GoalManager } from "@/goal/index.js";
import { rebuildFromSession } from "@/session/index.js";
import type { SessionMessage } from "@/session/index.js";
import { TaskStore } from "@/todo/store.js";
import { FileStateCache } from "@/tools/file-state-cache.js";

type SessionState = Pick<
  RemoteAgentHandle,
  | "conv"
  | "sessionId"
  | "cwd"
  | "fileHistory"
  | "fileStateCache"
  | "recoveryState"
  | "activeSkills"
  | "toolFilter"
  | "taskList"
  | "planFilePath"
  | "goalManager"
  | "backgroundTaskManager"
>;

export function restoreRemoteSession(
  state: SessionState,
  sessionId: string,
  saved: SessionMessage[],
) {
  const replay = rebuildFromSession(saved);
  state.backgroundTaskManager.useSession(sessionId);
  // AgentTool's fork closure holds this conversation object across runs.
  state.conv.reset();
  state.conv.appendMessages(replay);
  state.sessionId = sessionId;
  state.planFilePath = "";
  state.goalManager = new GoalManager(state.cwd, sessionId);
  state.fileHistory = new FileHistory(sessionId);
  state.fileStateCache = new FileStateCache();
  state.recoveryState = new RecoveryState();
  state.activeSkills.clear();
  state.toolFilter = null;
  state.taskList.useStore(new TaskStore(sessionId));
  return replay;
}

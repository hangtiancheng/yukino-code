import { RecoveryState } from "@yukino.js/compact/recovery.js";
import { FileHistory } from "@yukino.js/file-history";
import { GoalManager } from "@yukino.js/goal";
import { rebuildFromSession } from "@yukino.js/session";
import type { SessionMessage } from "@yukino.js/session";
import { TaskStore } from "@yukino.js/todo/store.js";
import { FileStateCache } from "@yukino.js/tools/file-state-cache.js";

import type { RemoteAgentHandle } from "./server.js";

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

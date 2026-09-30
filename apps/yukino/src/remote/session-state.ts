import type { RemoteAgentHandle } from "./server.js";

import { RecoveryState } from "@/compact/recovery.js";
import { FileHistory } from "@/file-history/index.js";
import { rebuildFromSession } from "@/session/index.js";
import type { SessionMessage } from "@/session/index.js";
import { TaskStore } from "@/todo/store.js";
import { FileStateCache } from "@/tools/file-state-cache.js";

type SessionState = Pick<
  RemoteAgentHandle,
  | "conv"
  | "sessionId"
  | "workDir"
  | "fileHistory"
  | "fileStateCache"
  | "recoveryState"
  | "activeSkills"
  | "toolFilter"
  | "taskList"
>;

export function restoreRemoteSession(
  state: SessionState,
  sessionId: string,
  saved: SessionMessage[],
) {
  const replay = rebuildFromSession(saved);
  // AgentTool's fork closure holds this conversation object across runs.
  state.conv.reset();
  state.conv.appendMessages(replay);
  state.sessionId = sessionId;
  state.fileHistory = new FileHistory(state.workDir, sessionId);
  state.fileStateCache = new FileStateCache();
  state.recoveryState = new RecoveryState();
  state.activeSkills.clear();
  state.toolFilter = null;
  state.taskList.useStore(new TaskStore(state.workDir, sessionId));
  return replay;
}

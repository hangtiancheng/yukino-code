/**
 * Copyright (c) 2026 hangtiancheng
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

import type { RemoteAgentHandle } from "./server.js";

import { RecoveryState } from "@/compact/recovery.js";
import { FileHistory } from "@/file-history/index.js";
import { rebuildFromSession } from "@/session/index.js";
import type { SessionMessage } from "@/session/index.js";
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
  return replay;
}

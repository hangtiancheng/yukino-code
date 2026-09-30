import { useCallback, useMemo } from "react";

import { CodeReviewDialog } from "./components/code-review-dialog";
import { InputArea } from "./components/input-area";
import { MessageList } from "./components/message-list";
import { PlanApprovalDialog } from "./components/plan-approval-dialog";
import { SessionPicker } from "./components/session-picker";
import { StatusBar } from "./components/status-bar";
import { useChat } from "./hooks/use-chat";
import { useWebSocket } from "./hooks/use-web-socket";
import type {
  ClientMessage,
  CodeReviewStartPayload,
  PermissionResponse,
  PlanChoice,
} from "./types";

export function App() {
  const {
    state,
    dispatchMessage,
    setConnection,
    respondPermission,
    markAskAnswered,
    closePlanApproval,
    closeSessions,
    closeCodeReview,
  } = useChat();

  const { send } = useWebSocket({
    onMessage: dispatchMessage,
    onOpen: () => {
      setConnection("connected");
    },
    onClose: () => {
      setConnection("reconnecting");
    },
  });

  const handleSend = useCallback(
    (text: string) => {
      const msg: ClientMessage = {
        type: "user_message",
        data: { content: text },
      };
      send(msg);
    },
    [send],
  );

  const handleCancel = useCallback(() => {
    send({ type: "cancel", data: null });
  }, [send]);

  const handleRespondPermission = useCallback(
    (id: string, response: PermissionResponse) => {
      respondPermission(id, response);
      const msg: ClientMessage = {
        type: "permission_response",
        data: { id, response },
      };
      send(msg);
    },
    [respondPermission, send],
  );

  const handleAnswerAsk = useCallback(
    (id: string, answers: Record<string, string>) => {
      markAskAnswered(id);
      const msg: ClientMessage = {
        type: "ask_user_response",
        data: { id, answers },
      };
      send(msg);
    },
    [markAskAnswered, send],
  );

  const handlePlanChoice = useCallback(
    (choice: PlanChoice, feedback?: string) => {
      closePlanApproval();
      send({ type: "plan_approval_response", data: { choice, feedback } });
    },
    [closePlanApproval, send],
  );

  const handlePickSession = useCallback(
    (id: string) => {
      closeSessions();
      send({ type: "user_message", data: { content: `/resume ${id}` } });
    },
    [closeSessions, send],
  );

  const handleCodeReviewRun = useCallback(
    (options: CodeReviewStartPayload) => {
      closeCodeReview();
      send({ type: "code_review_start", data: options });
    },
    [closeCodeReview, send],
  );

  const welcome = useMemo(
    () => ({
      session: state.session,
      cwd: state.cwd,
      model: state.model,
      thinkingLevel: state.thinkingLevel,
      permissionMode: state.permissionMode,
      connection: state.connection,
    }),
    [
      state.session,
      state.cwd,
      state.model,
      state.thinkingLevel,
      state.permissionMode,
      state.connection,
    ],
  );

  return (
    <div className="flex h-screen w-full flex-col bg-bg font-sans text-sm text-base antialiased">
      <StatusBar
        connection={state.connection}
        usage={state.usage}
        cwd={state.cwd}
        model={state.model}
        permissionMode={state.permissionMode}
        thinkingLevel={state.thinkingLevel}
      />
      <MessageList
        items={state.items}
        welcome={welcome}
        onRespondPermission={handleRespondPermission}
        onAnswerAsk={handleAnswerAsk}
      />
      <InputArea
        streaming={state.streaming}
        commands={state.commands}
        steering={state.steering}
        onSend={handleSend}
        onCancel={handleCancel}
      />
      {state.planApproval && (
        <PlanApprovalDialog
          request={state.planApproval}
          onChoose={handlePlanChoice}
        />
      )}
      {state.sessions && (
        <SessionPicker
          sessions={state.sessions}
          onPick={handlePickSession}
          onClose={closeSessions}
        />
      )}
      {state.codeReviewOpen && (
        <CodeReviewDialog
          onRun={handleCodeReviewRun}
          onClose={closeCodeReview}
        />
      )}
    </div>
  );
}

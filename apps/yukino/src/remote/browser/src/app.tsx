import { useCallback, useEffect, useMemo, useState } from "react";

import { ActivityPanel } from "./components/activity-panel";
import { CodeReviewDialog } from "./components/code-review-dialog";
import { InputArea } from "./components/input-area";
import { MessageList } from "./components/message-list";
import { ModelPicker } from "./components/model-picker";
import { PlanApprovalDialog } from "./components/plan-approval-dialog";
import { ProviderDialog } from "./components/provider-dialog";
import { RewindDialog } from "./components/rewind-dialog";
import { SessionPicker } from "./components/session-picker";
import { StatusBar } from "./components/status-bar";
import { ThinkingPicker } from "./components/thinking-picker";
import { TodoProgress } from "./components/todo-progress";
import { useChat } from "./hooks/use-chat";
import { useTheme } from "./hooks/use-theme";
import { useWebSocket } from "./hooks/use-web-socket";
import type {
  ClientMessage,
  CodeReviewStartPayload,
  PermissionModeChoice,
  PermissionResponse,
  PlanChoice,
  ProviderSavePayload,
  RewindChoice,
} from "./types";

/** Terminal PERMISSION_MODE_CYCLE: default → acceptEdits → bypassPermissions → plan. */
const MODE_CYCLE: PermissionModeChoice[] = [
  "default",
  "acceptEdits",
  "bypassPermissions",
  "plan",
];

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
    closeModelPicker,
    closeProviderPicker,
    closeRewindPicker,
    closeThinkingPicker,
    openThinkingPicker,
    appendHistory,
    consumeImageResult,
  } = useChat();

  const { theme, toggleTheme } = useTheme();
  const [activityOpen, setActivityOpen] = useState(false);

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
      appendHistory(text);
      const msg: ClientMessage = {
        type: "user_message",
        data: { content: text },
      };
      send(msg);
    },
    [appendHistory, send],
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

  const cyclePermissionMode = useCallback(() => {
    const current = state.permissionMode || "default";
    const index = MODE_CYCLE.findIndex((mode) => mode === current);
    const next = MODE_CYCLE[(index + 1) % MODE_CYCLE.length];
    if (next) {
      send({ type: "set_permission_mode", data: { mode: next } });
    }
  }, [state.permissionMode, send]);

  const handleModelSelect = useCallback(
    (model: string) => {
      closeModelPicker();
      send({ type: "model_select", data: { model } });
    },
    [closeModelPicker, send],
  );

  const handleProviderSelect = useCallback(
    (index: number) => {
      closeProviderPicker();
      send({ type: "provider_select", data: { index } });
    },
    [closeProviderPicker, send],
  );

  const handleProviderSave = useCallback(
    (form: ProviderSavePayload) => {
      closeProviderPicker();
      send({ type: "provider_save", data: form });
    },
    [closeProviderPicker, send],
  );

  const handleRewindAction = useCallback(
    (snapshotIndex: number, action: RewindChoice) => {
      closeRewindPicker();
      send({ type: "rewind_action", data: { snapshotIndex, action } });
    },
    [closeRewindPicker, send],
  );

  const handleThinkingSelect = useCallback(
    (level: string) => {
      closeThinkingPicker();
      send({ type: "user_message", data: { content: `/thinking ${level}` } });
    },
    [closeThinkingPicker, send],
  );

  const handleRequestFileCompletions = useCallback(
    (requestId: string, query: string) => {
      send({ type: "file_complete_request", data: { requestId, query } });
    },
    [send],
  );

  const handleUploadImage = useCallback(
    (clientId: string, name: string, dataBase64: string) => {
      send({ type: "image_upload", data: { clientId, name, dataBase64 } });
    },
    [send],
  );

  const handleBackgroundShells = useCallback(() => {
    send({ type: "background_shells", data: {} });
  }, [send]);

  const modalOpen =
    activityOpen ||
    state.planApproval !== null ||
    state.sessions !== null ||
    state.codeReviewOpen ||
    state.modelPicker !== null ||
    state.providerPicker !== null ||
    state.rewindPicker !== null ||
    state.thinkingPicker !== null;

  // Terminal Shift+Tab parity: cycle the permission mode from anywhere —
  // except while a modal owns the keyboard (Shift+Tab must move focus there).
  useEffect(() => {
    if (modalOpen) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.shiftKey && event.key === "Tab") {
        event.preventDefault();
        cyclePermissionMode();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [cyclePermissionMode, modalOpen]);

  const agentCount =
    state.subagents.filter((agent) => agent.status === "running").length +
    state.backgroundTasks.filter((task) => task.status === "running").length +
    state.teammates.length;

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
    <div className="flex h-dvh w-full flex-col bg-bg font-mono text-sm text-base antialiased">
      <MessageList
        items={state.items}
        welcome={welcome}
        onRespondPermission={handleRespondPermission}
        onAnswerAsk={handleAnswerAsk}
      />
      {state.todos && <TodoProgress todos={state.todos} />}
      <InputArea
        streaming={state.streaming}
        thinkingLevel={state.thinkingLevel}
        commands={state.commands}
        steering={state.steering}
        followUps={state.followUps}
        history={state.history}
        fileMatches={state.fileMatches}
        imageResults={state.imageResults}
        onSend={handleSend}
        onCancel={handleCancel}
        onRequestFileCompletions={handleRequestFileCompletions}
        onUploadImage={handleUploadImage}
        onConsumeImageResult={consumeImageResult}
        onBackgroundShells={handleBackgroundShells}
      />
      <StatusBar
        connection={state.connection}
        usage={state.usage}
        cwd={state.cwd}
        session={state.session}
        model={state.model}
        provider={state.provider}
        permissionMode={state.permissionMode}
        thinkingLevel={state.thinkingLevel}
        sandboxEnabled={state.sandboxEnabled}
        sandboxAutoAllow={state.sandboxAutoAllow}
        theme={theme}
        agentCount={agentCount}
        onToggleTheme={toggleTheme}
        onCycleMode={cyclePermissionMode}
        onOpenModelPicker={() => {
          send({ type: "model_list_request", data: {} });
        }}
        onOpenThinkingPicker={openThinkingPicker}
        onOpenActivity={() => {
          setActivityOpen(true);
        }}
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
      {state.modelPicker && (
        <ModelPicker
          state={state.modelPicker}
          onSelect={handleModelSelect}
          onClose={closeModelPicker}
        />
      )}
      {state.providerPicker && (
        <ProviderDialog
          state={state.providerPicker}
          onSelect={handleProviderSelect}
          onSave={handleProviderSave}
          onClose={closeProviderPicker}
        />
      )}
      {state.rewindPicker && (
        <RewindDialog
          snapshots={state.rewindPicker}
          onAction={handleRewindAction}
          onClose={closeRewindPicker}
        />
      )}
      {state.thinkingPicker && (
        <ThinkingPicker
          form={state.thinkingPicker}
          onSelect={handleThinkingSelect}
          onClose={closeThinkingPicker}
        />
      )}
      {activityOpen && (
        <ActivityPanel
          subagents={state.subagents}
          backgroundTasks={state.backgroundTasks}
          teammates={state.teammates}
          onClose={() => {
            setActivityOpen(false);
          }}
        />
      )}
    </div>
  );
}

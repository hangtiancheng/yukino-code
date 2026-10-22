import { useCallback, useEffect, useMemo, useState } from "react";

import { ActivityPanel } from "#/components/activity-panel.js";
import { InputArea } from "#/components/input-area.js";
import { MessageList } from "#/components/message-list.js";
import { ModelPicker } from "#/components/model-picker.js";
import { PlanApprovalDialog } from "#/components/plan-approval-dialog.js";
import { ProviderDialog } from "#/components/provider-dialog.js";
import { RewindDialog } from "#/components/rewind-dialog.js";
import { SessionPicker } from "#/components/session-picker.js";
import { StatusBar } from "#/components/status-bar.js";
import { ThinkingPicker } from "#/components/thinking-picker.js";
import { TodoProgress } from "#/components/todo-progress.js";
import { MODE_CYCLE } from "#/constants.js";
import { useChat } from "#/hooks/use-chat.js";
import { useTheme } from "#/hooks/use-theme.js";
import { useWebSocket } from "#/hooks/use-web-socket.js";
import { McpAppContext } from "#/lib/mcp-app-context.js";
import type {
  ClientMessage,
  PermissionResponse,
  PlanChoice,
  ProviderSavePayload,
  RewindChoice,
} from "#/types.js";

export function App() {
  const {
    state,
    dispatchMessage,
    setConnection,
    respondPermission,
    markAskAnswered,
    closePlanApproval,
    closeSessions,
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

  const { send, requestApp } = useWebSocket({
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
      if (send(msg) === "dropped") {
        return false;
      }
      appendHistory(text);
      return true;
    },
    [appendHistory, send],
  );

  const handleCancel = useCallback(() => {
    send({ type: "cancel", data: null });
  }, [send]);

  const handleRespondPermission = useCallback(
    (id: string, response: PermissionResponse) => {
      const msg: ClientMessage = {
        type: "permission_response",
        data: { id, response },
      };
      if (send(msg) === "sent") {
        respondPermission(id, response);
      }
    },
    [respondPermission, send],
  );

  const handleAnswerAsk = useCallback(
    (id: string, answers: Record<string, string>) => {
      const msg: ClientMessage = {
        type: "ask_user_response",
        data: { id, answers },
      };
      if (send(msg) === "sent") {
        markAskAnswered(id);
      }
    },
    [markAskAnswered, send],
  );

  const handlePlanChoice = useCallback(
    (choice: PlanChoice, feedback?: string) => {
      if (
        state.planApproval &&
        send({
          type: "plan_approval_response",
          data: { id: state.planApproval.id, choice, feedback },
        }) === "sent"
      ) {
        closePlanApproval();
      }
    },
    [closePlanApproval, state.planApproval, send],
  );

  const handlePickSession = useCallback(
    (id: string) => {
      closeSessions();
      send({ type: "user_message", data: { content: `/resume ${id}` } });
    },
    [closeSessions, send],
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
    (snapshotId: string, action: RewindChoice) => {
      closeRewindPicker();
      send({ type: "rewind_action", data: { snapshotId, action } });
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
      const status = send({
        type: "image_upload",
        data: { clientId, name, dataBase64 },
      });
      if (status === "dropped") {
        // Offline: an upload is never queued (large, and it resolves via a
        // server reply). Surface a local failure so the pending upload clears
        // instead of spinning forever.
        dispatchMessage({
          type: "image_error",
          data: { clientId, message: "Image upload failed: not connected." },
        });
      }
    },
    [send, dispatchMessage],
  );

  const handleBackgroundShells = useCallback(() => {
    send({ type: "background_shells", data: {} });
  }, [send]);

  const modalOpen =
    activityOpen ||
    state.planApproval !== null ||
    state.sessions !== null ||
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
      <McpAppContext.Provider
        value={{ request: requestApp, sendMessage: handleSend, theme }}
      >
        <MessageList
          items={state.items}
          revision={state.transcriptRevision}
          welcome={welcome}
          onRespondPermission={handleRespondPermission}
          onAnswerAsk={handleAnswerAsk}
        />
      </McpAppContext.Provider>
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
          key={state.planApproval.id}
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

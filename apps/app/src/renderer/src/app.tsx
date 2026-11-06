import { ChatArea } from "@renderer/components/chat/chat-area";
import { CommandPalette } from "@renderer/components/chat/command-palette";
import { Composer } from "@renderer/components/chat/composer";
import { Header } from "@renderer/components/chat/header";
import { PlanDialog } from "@renderer/components/chat/plan-dialog";
import { RuntimeDialog } from "@renderer/components/chat/runtime-dialog";
import { RuntimeStatus } from "@renderer/components/chat/runtime-status";
import { SettingsDialog } from "@renderer/components/chat/settings-dialog";
import { Sidebar } from "@renderer/components/chat/sidebar";
import { Button } from "@renderer/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@renderer/components/ui/dialog";
import { ErrorDetails } from "@renderer/components/ui/error-details";
import { Spinner } from "@renderer/components/ui/spinner";
import { Toaster } from "@renderer/components/ui/toaster";
import { TooltipProvider } from "@renderer/components/ui/tooltip";
import { EditorPanel } from "@renderer/components/workspace/editor-panel";
import { useChat } from "@renderer/hooks/use-chat";
import { useRuntime } from "@renderer/hooks/use-runtime";
import { McpAppContext } from "@renderer/lib/mcp/context";
import {
  AlertTriangleIcon,
  ArrowRightIcon,
  FolderOpenIcon,
  CpuIcon,
  BoxesIcon,
  SnowflakeIcon,
  TargetIcon,
  ListChecksIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Group,
  Panel,
  Separator,
  type GroupImperativeHandle,
} from "react-resizable-panels";
import { toast } from "sonner";

function formatTokens(tokens: number): string {
  return tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens);
}
const report = (error: unknown): void => {
  toast.error(error instanceof Error ? error.message : String(error));
};

function App(): React.JSX.Element {
  const chat = useChat();
  const { state } = chat;
  const init = state.init;
  const cwd = init?.ok ? init.cwd : null;
  const failed = init !== null && !init.ok;
  const booting = state.initializing && init === null;
  const [sidebarOpen, setSidebarOpen] = useState(
    () => window.innerWidth > 1150,
  );
  const [editorOpen, setEditorOpen] = useState(() => window.innerWidth >= 1200);
  const [editorExpanded, setEditorExpanded] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [runtimeOpen, setRuntimeOpen] = useState(false);
  const [commandsOpen, setCommandsOpen] = useState(false);
  const [composerDraft, setComposerDraft] = useState<{
    text: string;
    id: number;
    sessionId: string | null;
  } | null>(null);
  const draft = (text: string): void => {
    setComposerDraft((current) => ({
      text,
      id: (current?.id ?? 0) + 1,
      sessionId: state.activeSessionId,
    }));
  };
  const runtime = useRuntime(
    init?.ok ? state.activeSessionId : null,
    state.streaming,
  );
  const sessionTitle =
    state.items.find((item) => item.kind === "user")?.text ?? "新会话";
  const [draftProject, setDraftProject] = useState<string | null>(null);
  const dirty = draftProject !== null && draftProject === cwd;
  const setDirty = useCallback(
    (value: boolean) => {
      setDraftProject(value ? cwd : null);
    },
    [cwd],
  );
  const [pendingAction, setPendingAction] = useState<(() => void) | null>(null);
  const group = useRef<GroupImperativeHandle>(null);
  const splitSize = useRef(48);
  const hasItems = state.items.length > 0;
  const pending = state.items.filter((item) =>
    item.kind === "permission"
      ? item.response === null
      : item.kind === "ask" && !item.answered,
  ).length;
  const guard = (action: () => void): void => {
    if (dirty) {
      setPendingAction(() => action);
    } else {
      action();
    }
  };
  const chooseFolder = (): void => {
    guard(chat.chooseFolder);
  };

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      if (cwd) {
        group.current?.setLayout({
          conversation: editorOpen
            ? editorExpanded
              ? 0
              : 100 - splitSize.current
            : 100,
          editor: editorOpen ? (editorExpanded ? 100 : splitSize.current) : 0,
        });
      }
    });
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [cwd, editorOpen, editorExpanded]);

  useEffect(
    () =>
      window.api.onEvent((event) => {
        if (event.type === "open_settings") {
          setSettingsOpen(true);
        }
        if (event.type === "open_runtime") {
          setRuntimeOpen(true);
        }
      }),
    [],
  );
  useEffect(() => {
    const handle = (event: KeyboardEvent): void => {
      if (!event.metaKey && !event.ctrlKey) {
        return;
      }
      const key = event.key.toLowerCase();
      if (event.isComposing) {
        return;
      }
      if (key === "k") {
        event.preventDefault();
        setCommandsOpen((value) => !value);
      }
      if (key === "b") {
        event.preventDefault();
        setSidebarOpen((value) => !value);
      }
      if (key === "j") {
        event.preventDefault();
        setEditorOpen((value) => !value);
      }
      if (key === ",") {
        event.preventDefault();
        setSettingsOpen(true);
      }
      if (key === "n" && !state.streaming && !state.initializing) {
        event.preventDefault();
        chat.startNewSession();
      }
    };
    window.addEventListener("keydown", handle);
    return () => {
      window.removeEventListener("keydown", handle);
    };
  }, [chat.startNewSession, state.streaming, state.initializing]);
  useEffect(() => {
    const prevent = (event: BeforeUnloadEvent): void => {
      if (dirty) {
        event.preventDefault();
      }
    };
    window.addEventListener("beforeunload", prevent);
    return () => {
      window.removeEventListener("beforeunload", prevent);
    };
  }, [dirty]);

  const mcpHost = useMemo<NonNullable<React.ContextType<typeof McpAppContext>>>(
    () => ({
      request: (appId, operation) => window.api.requestMcpApp(appId, operation),
      sendMessage: (text) => {
        chat.send(text);
        return true;
      },
      theme: chat.isDark ? "dark" : "light",
    }),
    [chat.send, chat.isDark],
  );

  return (
    <TooltipProvider>
      <McpAppContext.Provider value={mcpHost}>
        <div className="app-shell">
          <Sidebar
            open={sidebarOpen}
            sessions={state.sessions}
            activeSessionId={state.activeSessionId}
            currentProjectKey={init?.ok ? init.projectKey : null}
            onResumeSession={(id, path) => {
              guard(() => {
                chat.resumeSession(id, path);
              });
            }}
            onClose={() => {
              setSidebarOpen(false);
            }}
            onNewSession={chat.startNewSession}
            disabled={state.streaming || state.initializing}
          />
          {sidebarOpen ? (
            <button
              className="sidebar-scrim"
              aria-label="关闭会话导航"
              onClick={() => {
                setSidebarOpen(false);
              }}
            />
          ) : null}
          <div className="flex h-full min-w-0 flex-1 flex-col">
            <Header
              init={init}
              sidebarOpen={sidebarOpen}
              editorOpen={editorOpen}
              streaming={state.streaming || state.initializing}
              onToggleSidebar={() => {
                setSidebarOpen((value) => !value);
              }}
              onToggleEditor={() => {
                setEditorOpen((value) => !value);
              }}
              onChooseFolder={chooseFolder}
              onOpenSettings={() => {
                setSettingsOpen(true);
              }}
              onOpenRuntime={() => {
                setRuntimeOpen(true);
              }}
              onOpenCommands={() => {
                setCommandsOpen(true);
              }}
              sessionTitle={sessionTitle}
            />
            <Group
              groupRef={group}
              className="workspace-layout"
              orientation="horizontal"
              onLayoutChanged={(layout, meta) => {
                if (
                  meta.isUserInteraction &&
                  editorOpen &&
                  !editorExpanded &&
                  layout.editor > 0
                ) {
                  splitSize.current = layout.editor;
                }
              }}
            >
              <Panel
                id="conversation"
                defaultSize="52%"
                minSize={editorOpen && editorExpanded ? "0%" : "30%"}
                maxSize={editorOpen && editorExpanded ? "0%" : "100%"}
                className={`conversation ${editorOpen && editorExpanded ? "conversation-hidden" : ""}`}
                role="main"
              >
                <div className="conversation-heading">
                  <span
                    className={
                      state.streaming ? "status-dot working" : "status-dot"
                    }
                  />
                  <span>
                    {state.streaming
                      ? pending
                        ? "等待你的回应"
                        : "正在处理任务"
                      : state.initializing
                        ? "正在打开…"
                        : failed
                          ? "未连接"
                          : "就绪"}
                  </span>
                </div>
                {runtime.data?.goal || runtime.data?.tasks.length ? (
                  <button
                    className="task-ribbon"
                    onClick={() => {
                      setRuntimeOpen(true);
                    }}
                  >
                    {runtime.data.goal ? <TargetIcon /> : <ListChecksIcon />}
                    <span>
                      {runtime.data.goal?.objective ??
                        runtime.data.tasks.find(
                          (task) => task.status === "in_progress",
                        )?.subject ??
                        "任务清单"}
                    </span>
                    {runtime.data.tasks.length ? (
                      <small>
                        {
                          runtime.data.tasks.filter(
                            (task) => task.status === "completed",
                          ).length
                        }
                        /{runtime.data.tasks.length}
                      </small>
                    ) : runtime.data.goal ? (
                      <RuntimeStatus status={runtime.data.goal.status} />
                    ) : null}
                    <ArrowRightIcon />
                  </button>
                ) : null}
                {failed ? (
                  <div className="flex min-h-0 flex-1 items-center justify-center p-6">
                    <div className="setup-panel">
                      <AlertTriangleIcon className="text-warning size-7" />
                      <h2>
                        {init.kind === "project"
                          ? "项目无法打开"
                          : init.kind === "config"
                            ? "配置服务商"
                            : "连接失败"}
                      </h2>
                      <p>{init.error}</p>
                      {init.details || init.configPath ? (
                        <ErrorDetails>
                          {init.details ?? init.configPath!}
                        </ErrorDetails>
                      ) : null}
                      <div className="flex flex-wrap gap-2">
                        {init.kind === "project" ? (
                          <Button onClick={chooseFolder}>
                            <FolderOpenIcon />
                            选择项目
                          </Button>
                        ) : (
                          <Button
                            onClick={() => {
                              setSettingsOpen(true);
                            }}
                          >
                            {init.kind === "config" ? "添加服务商" : "检查设置"}
                          </Button>
                        )}
                        <Button
                          variant="outline"
                          onClick={chat.retry}
                          disabled={state.initializing}
                        >
                          {state.initializing ? <Spinner /> : null}重新连接
                        </Button>
                      </div>
                    </div>
                  </div>
                ) : booting ? (
                  <div className="panel-empty flex-1">
                    <Spinner />
                    正在连接 Agent…
                  </div>
                ) : hasItems ? (
                  <ChatArea
                    items={state.items}
                    streaming={state.streaming}
                    activeSubagents={state.activeSubagents}
                    onRespondPermission={chat.respondPermission}
                    onRespondAsk={chat.respondAsk}
                  />
                ) : (
                  <div className="conversation-placeholder" aria-hidden="true">
                    <SnowflakeIcon strokeWidth={1.2} />
                  </div>
                )}
                {!failed && !booting ? (
                  <footer className="composer-container">
                    <Composer
                      key={state.activeSessionId}
                      streaming={state.streaming}
                      disabled={!init?.ok || state.initializing}
                      onSend={chat.send}
                      onAbort={chat.abort}
                      draft={
                        composerDraft?.sessionId === state.activeSessionId
                          ? composerDraft
                          : null
                      }
                      model={init?.ok ? init.model : "未连接"}
                      permissionMode={
                        init?.ok ? init.permissionMode : "default"
                      }
                      onOpenSettings={() => {
                        setSettingsOpen(true);
                      }}
                      onPermissionMode={(mode) => {
                        void window.api.setPermissionMode(mode).catch(report);
                      }}
                    />
                    <div className="composer-meta">
                      {init?.ok ? (
                        <span className="flex items-center gap-1.5">
                          <CpuIcon className="size-3" />
                          {init.providerName} · {init.thinkingLevel}
                        </span>
                      ) : null}
                      {state.usage ? (
                        <span className="ml-auto shrink-0 tabular-nums">
                          {formatTokens(state.usage.inputTokens)} 输入 /{" "}
                          {formatTokens(state.usage.outputTokens)} 输出
                        </span>
                      ) : null}
                    </div>
                  </footer>
                ) : null}
              </Panel>
              {cwd ? (
                <>
                  <Separator
                    aria-label="调整代码工作区宽度"
                    className={`workspace-resizer ${!editorOpen || editorExpanded ? "hidden" : ""}`}
                  />
                  <Panel
                    id="editor"
                    defaultSize="48%"
                    minSize={editorOpen ? "30%" : "0%"}
                    maxSize={editorOpen ? "100%" : "0%"}
                    className={`workspace-editor ${editorOpen ? "" : "editor-hidden"} ${editorExpanded ? "editor-expanded" : ""}`}
                    inert={!editorOpen}
                  >
                    <EditorPanel
                      key={cwd}
                      cwd={cwd}
                      dark={chat.isDark}
                      expanded={editorExpanded}
                      onExpand={() => {
                        setEditorExpanded((value) => !value);
                      }}
                      onClose={() => {
                        setEditorOpen(false);
                      }}
                      onDirtyChange={setDirty}
                    />
                  </Panel>
                </>
              ) : null}
            </Group>
            <div className="app-status">
              <span className="status-path" title={cwd ?? ""}>
                {cwd ?? "请选择项目文件夹"}
              </span>
              <span className="ml-auto flex items-center gap-1.5">
                <BoxesIcon className="size-3" />
                {runtime.data
                  ? `${runtime.data.tools.length} 工具 · ${runtime.data.mcpServers.length} MCP`
                  : ""}
              </span>
              {state.usage && init?.ok ? (
                <span
                  className="context-meter"
                  title={`${state.usage.inputTokens.toLocaleString()} / ${init.contextWindow.toLocaleString()} tokens`}
                >
                  <progress
                    aria-label="上下文使用率"
                    max={init.contextWindow}
                    value={state.usage.inputTokens}
                  />
                  <span>
                    {Math.round(
                      (state.usage.inputTokens / init.contextWindow) * 100,
                    )}
                    %
                  </span>
                </span>
              ) : null}
            </div>
          </div>
        </div>
        <SettingsDialog
          open={settingsOpen}
          onOpenChange={setSettingsOpen}
          streaming={state.streaming}
          themeMode={chat.themeMode}
          onThemeMode={chat.setThemeMode}
        />
        <RuntimeDialog
          key={state.activeSessionId}
          open={runtimeOpen}
          onOpenChange={setRuntimeOpen}
          streaming={state.streaming}
          dirty={dirty}
          data={runtime.data}
          error={runtime.error}
          refreshing={runtime.isFetching}
          onRefresh={() => {
            void runtime.refetch();
          }}
          onPrompt={chat.send}
        />
        <CommandPalette
          open={commandsOpen}
          onOpenChange={setCommandsOpen}
          busy={state.streaming || state.initializing}
          connected={Boolean(init?.ok)}
          onCommand={chat.send}
          onDraft={draft}
          onNewSession={chat.startNewSession}
          onChooseFolder={chooseFolder}
          onOpenSettings={() => {
            setSettingsOpen(true);
          }}
          onOpenRuntime={() => {
            setRuntimeOpen(true);
          }}
          onToggleEditor={() => {
            setEditorOpen((value) => !value);
          }}
        />
        <Dialog
          open={pendingAction !== null}
          onOpenChange={(open) => {
            if (!open) {
              setPendingAction(null);
            }
          }}
        >
          <DialogContent>
            <DialogTitle>有尚未保存的文件</DialogTitle>
            <DialogDescription>
              切换项目可能丢失编辑器中的草稿。请先保存，或选择继续切换。
            </DialogDescription>
            <div className="flex justify-end gap-2">
              <Button
                variant="outline"
                onClick={() => {
                  setPendingAction(null);
                }}
              >
                返回保存
              </Button>
              <Button
                variant="destructive"
                onClick={() => {
                  pendingAction?.();
                  setPendingAction(null);
                }}
              >
                继续切换
              </Button>
            </div>
          </DialogContent>
        </Dialog>
        <PlanDialog />
        <Toaster />
      </McpAppContext.Provider>
    </TooltipProvider>
  );
}
export default App;

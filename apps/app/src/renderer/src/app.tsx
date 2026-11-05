import { ChatArea } from "@renderer/components/chat/chat-area";
import { Composer } from "@renderer/components/chat/composer";
import { EmptyState } from "@renderer/components/chat/empty-state";
import { Header } from "@renderer/components/chat/header";
import { PlanDialog } from "@renderer/components/chat/plan-dialog";
import { RuntimeDialog } from "@renderer/components/chat/runtime-dialog";
import { SettingsDialog } from "@renderer/components/chat/settings-dialog";
import { Sidebar } from "@renderer/components/chat/sidebar";
import { Button } from "@renderer/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@renderer/components/ui/dialog";
import { Spinner } from "@renderer/components/ui/spinner";
import { Toaster } from "@renderer/components/ui/toaster";
import { TooltipProvider } from "@renderer/components/ui/tooltip";
import { EditorPanel } from "@renderer/components/workspace/editor-panel";
import { useChat } from "@renderer/hooks/use-chat";
import { McpAppContext } from "@renderer/lib/mcp/context";
import {
  AlertTriangleIcon,
  ArrowRightIcon,
  CheckIcon,
  CircleDotIcon,
  FolderOpenIcon,
  ShieldCheckIcon,
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
  const [editorOpen, setEditorOpen] = useState(true);
  const [editorExpanded, setEditorExpanded] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [runtimeOpen, setRuntimeOpen] = useState(false);
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
      if (key === "n" && !state.streaming) {
        event.preventDefault();
        chat.startNewSession();
      }
    };
    window.addEventListener("keydown", handle);
    return () => {
      window.removeEventListener("keydown", handle);
    };
  }, [chat.startNewSession, state.streaming]);
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
            disabled={state.streaming}
          />
          <div className="flex h-full min-w-0 flex-1 flex-col">
            <Header
              init={init}
              sidebarOpen={sidebarOpen}
              editorOpen={editorOpen}
              dark={chat.isDark}
              streaming={state.streaming}
              onToggleSidebar={() => {
                setSidebarOpen((value) => !value);
              }}
              onToggleEditor={() => {
                setEditorOpen((value) => !value);
              }}
              onChooseFolder={chooseFolder}
              onThemeMode={chat.setThemeMode}
              onOpenSettings={() => {
                setSettingsOpen(true);
              }}
              onOpenRuntime={() => {
                setRuntimeOpen(true);
              }}
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
                      : "就绪"}
                  </span>
                  <button
                    className="text-button ml-auto"
                    onClick={() => {
                      setRuntimeOpen(true);
                    }}
                  >
                    {state.activeSubagents
                      ? `${state.activeSubagents} 个 Agent 协作中`
                      : "任务"}
                    <ArrowRightIcon className="size-3" />
                  </button>
                </div>
                {failed ? (
                  <div className="flex min-h-0 flex-1 items-center justify-center p-6">
                    <div className="setup-panel">
                      <AlertTriangleIcon className="text-warning size-7" />
                      <h2>连接失败</h2>
                      <p>{init.error}</p>
                      {init.configPath ? <code>{init.configPath}</code> : null}
                      <div className="flex gap-2">
                        <Button
                          onClick={() => {
                            setSettingsOpen(true);
                          }}
                        >
                          添加服务商
                        </Button>
                        <Button variant="outline" onClick={chat.retry}>
                          重新连接
                        </Button>
                      </div>
                      <button
                        className="text-button text-muted-foreground"
                        onClick={chooseFolder}
                      >
                        <FolderOpenIcon className="size-3.5" />
                        选择其他项目
                      </button>
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
                  <div className="welcome-container">
                    <EmptyState onPrompt={chat.send} />
                  </div>
                )}
                {!failed && !booting ? (
                  <footer className="composer-container">
                    <Composer
                      streaming={state.streaming}
                      disabled={!init?.ok}
                      onSend={chat.send}
                      onAbort={chat.abort}
                    />
                    <div className="composer-meta">
                      <button
                        onClick={() => {
                          setSettingsOpen(true);
                        }}
                        className="truncate"
                        title="模型与推理设置"
                      >
                        {init?.ok ? init.model : "未连接"}
                        <span className="text-muted-foreground ml-2">
                          {init?.ok ? init.thinkingLevel : ""}
                        </span>
                      </button>
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
              <span className="flex items-center gap-1.5">
                {state.streaming ? (
                  <CircleDotIcon className="text-primary size-3" />
                ) : (
                  <CheckIcon className="text-success size-3" />
                )}
                {state.streaming ? "运行中" : "Yukino"}
              </span>
              <span className="status-path" title={cwd ?? ""}>
                {cwd ?? "请选择项目文件夹"}
              </span>
              <span className="ml-auto flex items-center gap-1">
                <ShieldCheckIcon className="size-3" />
                <select
                  aria-label="Agent 权限模式"
                  disabled={state.streaming || !init?.ok}
                  value={init?.ok ? init.permissionMode : "default"}
                  onChange={(event) => {
                    void window.api
                      .setPermissionMode(
                        event.target.value as
                          | "default"
                          | "acceptEdits"
                          | "plan"
                          | "bypassPermissions",
                      )
                      .catch(report);
                  }}
                >
                  <option value="default">逐项授权</option>
                  <option value="acceptEdits">自动接受文件编辑</option>
                  <option value="plan">只读规划</option>
                  <option value="bypassPermissions">自动允许所有工具</option>
                </select>
              </span>
            </div>
          </div>
        </div>
        <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
        <RuntimeDialog
          open={runtimeOpen}
          onOpenChange={setRuntimeOpen}
          streaming={state.streaming || dirty}
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

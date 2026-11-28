import { ChatArea } from "@renderer/components/chat/chat-area";
import { ChatItemRow } from "@renderer/components/chat/chat-item";
import { CommandPalette } from "@renderer/components/chat/command-palette";
import { Composer } from "@renderer/components/chat/composer";
import { Header } from "@renderer/components/chat/header";
import { MessageQueue } from "@renderer/components/chat/message-queue";
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
  PreferencesContext,
  DEFAULT_PREFERENCES,
} from "@renderer/lib/preferences";
import type { WorkbenchPage } from "@shared/workspace-types";
import {
  AlertTriangleIcon,
  ArrowRightIcon,
  FolderOpenIcon,
  CpuIcon,
  BoxesIcon,
  SnowflakeIcon,
  TargetIcon,
  ListChecksIcon,
  MessageSquareIcon,
  SearchIcon,
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
  const [compact, setCompact] = useState(() => window.innerWidth < 720);
  const fullEditor = editorOpen && (editorExpanded || compact);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [runtimeOpen, setRuntimeOpen] = useState(false);
  const [runtimePage, setRuntimePage] = useState<WorkbenchPage>("overview");
  const [commandsOpen, setCommandsOpen] = useState(false);
  const [composerDraft, setComposerDraft] = useState<{
    text: string;
    id: number;
    sessionId: string | null;
    append: boolean;
  } | null>(null);
  const draft = (text: string, append = false): void => {
    setComposerDraft((current) => ({
      text,
      id: (current?.id ?? 0) + 1,
      sessionId: state.activeSessionId,
      append,
    }));
  };
  const runtime = useRuntime(
    init?.ok ? state.activeSessionId : null,
    state.streaming,
  );
  const sessionTitle =
    state.sessions.find((session) => session.id === state.activeSessionId)
      ?.firstMessage ||
    state.items.find((item) => item.kind === "user")?.text ||
    "New session";
  const openRuntime = (page: WorkbenchPage = "overview"): void => {
    setRuntimePage(page);
    setRuntimeOpen(true);
  };
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
    const media = window.matchMedia("(width < 720px)");
    const onChange = (): void => {
      setCompact(media.matches);
    };
    media.addEventListener("change", onChange);
    return () => {
      media.removeEventListener("change", onChange);
    };
  }, []);

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      if (cwd) {
        group.current?.setLayout({
          conversation: editorOpen
            ? fullEditor
              ? 0
              : 100 - splitSize.current
            : 100,
          editor: editorOpen ? (fullEditor ? 100 : splitSize.current) : 0,
        });
      }
    });
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [cwd, editorOpen, fullEditor]);

  useEffect(
    () =>
      window.api.onEvent((event) => {
        if (event.type === "open_settings") {
          setSettingsOpen(true);
        }
        if (event.type === "open_runtime") {
          setRuntimePage(event.page ?? "overview");
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
    <PreferencesContext.Provider
      value={state.preferences?.values ?? DEFAULT_PREFERENCES}
    >
      <TooltipProvider>
        <McpAppContext.Provider value={mcpHost}>
          <div className="bg-background flex h-full min-w-0">
            <Sidebar
              open={sidebarOpen}
              sessions={state.sessions}
              activeSessionId={state.activeSessionId}
              currentProjectKey={init?.ok ? init.projectKey : null}
              onResumeSession={(id, path) => {
                guard(() => {
                  chat.resumeSession(id, path);
                  if (window.innerWidth <= 1000) {
                    setSidebarOpen(false);
                  }
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
                className="max-[1000px]:bg-scrim/25 hidden max-[1000px]:fixed max-[1000px]:inset-0 max-[1000px]:z-35 max-[1000px]:block max-[1000px]:backdrop-blur-[2px]"
                aria-label="Close session navigation"
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
                onOpenRuntime={openRuntime}
                onOpenCommands={() => {
                  setCommandsOpen(true);
                }}
                sessionTitle={sessionTitle}
              />
              <Group
                groupRef={group}
                className="relative flex min-h-0 flex-1 overflow-hidden"
                orientation="horizontal"
                onLayoutChanged={(layout, meta) => {
                  if (
                    meta.isUserInteraction &&
                    editorOpen &&
                    !fullEditor &&
                    layout.editor > 0
                  ) {
                    splitSize.current = layout.editor;
                  }
                }}
              >
                <Panel
                  id="conversation"
                  defaultSize="52%"
                  minSize={fullEditor ? "0%" : "30%"}
                  maxSize={fullEditor ? "0%" : "100%"}
                  className={`workspace-conversation flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden ${fullEditor ? "hidden" : ""}`}
                  role="main"
                >
                  <div className="conversation-heading">
                    <span className="flex min-w-0 items-center gap-2 font-semibold">
                      <MessageSquareIcon className="text-accent-foreground size-3.5 shrink-0" />{" "}
                      Conversation
                    </span>
                    <span
                      role="status"
                      className="text-muted-foreground inline-flex shrink-0 items-center gap-1.5 text-[11px]"
                    >
                      <span
                        aria-hidden="true"
                        className={
                          failed || pending
                            ? "bg-warning inline-block size-1.5 shrink-0 rounded-full"
                            : state.streaming || state.initializing
                              ? "animate-status-pulse bg-primary inline-block size-1.5 shrink-0 rounded-full shadow-[0_0_0_3px_color-mix(in_srgb,var(--primary)_12%,transparent)]"
                              : "bg-success inline-block size-1.5 shrink-0 rounded-full"
                        }
                      />
                      {pending
                        ? "Awaiting your response"
                        : state.streaming
                          ? "Working…"
                          : state.initializing
                            ? "Opening…"
                            : failed
                              ? "Not connected"
                              : "Ready"}
                    </span>
                  </div>
                  {runtime.data?.goal || runtime.data?.tasks.length ? (
                    <button
                      className="workbench-tile mx-5.5 mb-2.5 flex items-center gap-2.25 rounded-[9px] border px-3 py-2.5 text-left text-[11px]"
                      onClick={() => {
                        openRuntime("tasks");
                      }}
                    >
                      {runtime.data.goal ? (
                        <TargetIcon className="text-accent-foreground size-3.5 shrink-0" />
                      ) : (
                        <ListChecksIcon className="text-accent-foreground size-3.5 shrink-0" />
                      )}
                      <span className="min-w-0 flex-1 truncate">
                        {runtime.data.goal?.objective ??
                          runtime.data.tasks.find(
                            (task) => task.status === "in_progress",
                          )?.subject ??
                          "Task list"}
                      </span>
                      {runtime.data.tasks.length ? (
                        <small className="text-muted-foreground shrink-0 text-[10px] tabular-nums">
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
                      <ArrowRightIcon className="text-accent-foreground size-3.5 shrink-0" />
                    </button>
                  ) : null}
                  {failed ? (
                    <div className="flex min-h-0 flex-1 items-center justify-center p-6">
                      <div className="border-border bg-card flex w-[min(100%,390px)] min-w-0 flex-col items-start gap-4 rounded-[14px] border p-6.5">
                        <AlertTriangleIcon className="text-warning size-7" />
                        <h2 className="text-[22px] font-semibold">
                          {init.kind === "project"
                            ? "Unable to open project"
                            : init.kind === "config"
                              ? "Configure a provider"
                              : "Connection failed"}
                        </h2>
                        <p className="text-muted-foreground max-w-full text-xs leading-[1.8] wrap-anywhere">
                          {init.error}
                        </p>
                        {init.details || init.configPath ? (
                          <ErrorDetails>
                            {init.details ?? init.configPath!}
                          </ErrorDetails>
                        ) : null}
                        <div className="flex flex-wrap gap-2">
                          {init.kind === "project" ? (
                            <Button onClick={chooseFolder}>
                              <FolderOpenIcon />
                              Choose project
                            </Button>
                          ) : (
                            <Button
                              onClick={() => {
                                setSettingsOpen(true);
                              }}
                            >
                              {init.kind === "config"
                                ? "Add provider"
                                : "Check settings"}
                            </Button>
                          )}
                          <Button
                            variant="outline"
                            onClick={chat.retry}
                            disabled={state.initializing}
                          >
                            {state.initializing ? <Spinner /> : null}Reconnect
                          </Button>
                        </div>
                      </div>
                    </div>
                  ) : booting ? (
                    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-5 text-center text-xs">
                      <Spinner />
                      Connecting to the agent…
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
                    <div className="conversation-start">
                      <section
                        className="conversation-welcome"
                        aria-labelledby="conversation-title"
                      >
                        <span className="welcome-mark" aria-hidden="true">
                          <SnowflakeIcon
                            className="text-primary size-10"
                            strokeWidth={1.5}
                          />
                        </span>
                        <h1
                          id="conversation-title"
                          className="text-[clamp(1.65rem,3.3vw,2.8rem)] leading-[1.1] font-semibold tracking-[-0.045em] text-balance"
                        >
                          What are we building?
                        </h1>
                        <p className="text-muted-foreground mt-3 max-w-76 text-sm leading-relaxed text-pretty">
                          Ask a question about your project or describe a change
                          for Yukino to make.
                        </p>
                        <div className="mt-6 flex flex-wrap gap-2">
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => {
                              setCommandsOpen(true);
                            }}
                          >
                            <SearchIcon /> Browse commands
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => {
                              openRuntime();
                            }}
                          >
                            <BoxesIcon /> Open workbench
                          </Button>
                        </div>
                      </section>
                    </div>
                  )}
                  {!failed && !booting ? (
                    <footer className="mx-auto w-full max-w-212.5 shrink-0 px-5.5 pt-3.5 pb-3.25 max-[1200px]:px-4">
                      <MessageQueue
                        key={`queue-${state.activeSessionId}`}
                        entries={state.queue}
                        onRecall={(text) => {
                          draft(text, true);
                        }}
                      />
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
                        model={init?.ok ? init.model : "Not connected"}
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
                      <div className="text-muted-foreground flex min-w-0 items-center gap-3 px-1 pt-2.5 text-[10px]">
                        {init?.ok ? (
                          <span
                            className="flex min-w-0 flex-1 items-center gap-1.5"
                            title={`${init.providerName} · ${init.thinkingLevel}`}
                          >
                            <CpuIcon className="size-3 shrink-0" />
                            <span className="truncate">
                              {init.providerName} · {init.thinkingLevel}
                            </span>
                          </span>
                        ) : null}
                        {state.usage ? (
                          <span className="ml-auto shrink-0 tabular-nums">
                            {formatTokens(state.usage.inputTokens)} in /{" "}
                            {formatTokens(state.usage.outputTokens)} out
                          </span>
                        ) : null}
                      </div>
                    </footer>
                  ) : null}
                </Panel>
                {cwd ? (
                  <>
                    <Separator
                      aria-label="Resize code workspace"
                      className={`workspace-divider ${!editorOpen || fullEditor ? "hidden" : ""}`}
                    />
                    <Panel
                      id="editor"
                      defaultSize="48%"
                      minSize={editorOpen ? 320 : 0}
                      maxSize={editorOpen ? "100%" : "0%"}
                      className={`min-w-0 overflow-hidden ${editorOpen ? "" : "hidden"}`}
                      inert={!editorOpen}
                    >
                      <EditorPanel
                        key={cwd}
                        cwd={cwd}
                        dark={chat.isDark}
                        expanded={fullEditor}
                        canExpand={!compact}
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
              <div className="workspace-toolbar text-muted-foreground flex h-7 min-w-0 shrink-0 items-center gap-3.5 border-t px-4 text-[11px]">
                <span
                  className="flex min-w-0 flex-1 items-center gap-2"
                  title={cwd ?? ""}
                >
                  <FolderOpenIcon className="size-3 shrink-0" />
                  <span className="truncate">
                    {cwd ?? "Choose a project folder"}
                  </span>
                </span>
                {runtime.data ? (
                  <button
                    type="button"
                    aria-label="Inspect tools and skills"
                    className="hover:text-accent-foreground ml-auto flex shrink-0 items-center gap-1.5"
                    onClick={() => {
                      openRuntime("capabilities");
                    }}
                  >
                    <BoxesIcon className="size-3" />
                    {runtime.data.tools.length} tools ·{" "}
                    {runtime.data.mcpServers.length} MCP
                  </button>
                ) : null}
                {state.usage && init?.ok ? (
                  <span
                    className="flex shrink-0 items-center gap-1.5 tabular-nums"
                    title={`${state.usage.inputTokens.toLocaleString()} / ${init.contextWindow.toLocaleString()} tokens`}
                  >
                    <progress
                      className="bg-muted [&::-webkit-progress-bar]:bg-muted [&::-webkit-progress-value]:bg-primary h-0.75 w-10.5 appearance-none overflow-hidden rounded-[3px] border-0"
                      aria-label="Context usage"
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
            page={runtimePage}
            onPageChange={setRuntimePage}
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
            onOpenRuntime={openRuntime}
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
              <DialogTitle>Unsaved files</DialogTitle>
              <DialogDescription>
                Save your editor drafts before switching projects, or discard
                them to continue.
              </DialogDescription>
              <div className="flex flex-wrap justify-end gap-2">
                <Button
                  variant="outline"
                  onClick={() => {
                    setPendingAction(null);
                  }}
                >
                  Keep editing
                </Button>
                <Button
                  variant="destructive"
                  onClick={() => {
                    pendingAction?.();
                    setPendingAction(null);
                  }}
                >
                  Switch anyway
                </Button>
              </div>
            </DialogContent>
          </Dialog>
          <Dialog
            open={
              (booting ||
                failed ||
                runtimeOpen ||
                settingsOpen ||
                commandsOpen ||
                (editorOpen && editorExpanded)) &&
              pending > 0
            }
          >
            <DialogContent
              showCloseButton={false}
              className="max-h-[85vh] overflow-y-auto sm:max-w-2xl"
            >
              <DialogTitle>Agent approval</DialogTitle>
              <DialogDescription>
                Review the requested permission or question to continue.
              </DialogDescription>
              {state.items
                .filter((item) =>
                  item.kind === "ask"
                    ? !item.answered
                    : item.kind === "permission" && !item.response,
                )
                .map((item) => (
                  <ChatItemRow
                    key={item.id}
                    item={item}
                    onRespondAsk={chat.respondAsk}
                    onRespondPermission={chat.respondPermission}
                  />
                ))}
              <div className="flex justify-end">
                <Button variant="outline" size="sm" onClick={chat.abort}>
                  Cancel operation
                </Button>
              </div>
            </DialogContent>
          </Dialog>
          <PlanDialog />
          <Toaster />
        </McpAppContext.Provider>
      </TooltipProvider>
    </PreferencesContext.Provider>
  );
}
export default App;

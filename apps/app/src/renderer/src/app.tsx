// App shell: header, scrolling chat surface, and composer. All agent state
// lives in the useChat hook; this file is presentation only.

import { AlertTriangleIcon } from "lucide-react";
import type { InitState } from "@shared/ipc-types";
import { useChat } from "@renderer/hooks/use-chat";
import { Header } from "@renderer/components/chat/header";
import { Composer } from "@renderer/components/chat/composer";
import { EmptyState } from "@renderer/components/chat/empty-state";
import { ChatItemRow } from "@renderer/components/chat/chat-item";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@renderer/components/ui/message-scroller";
import { Separator } from "@renderer/components/ui/separator";
import { Spinner } from "@renderer/components/ui/spinner";
import { TooltipProvider } from "@renderer/components/ui/tooltip";

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`;
  return String(tokens);
}

function InitFailure({
  init,
}: {
  init: InitState & { ok: false };
}): React.JSX.Element {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center p-6">
      <div className="border-border bg-card flex max-w-md flex-col items-center gap-3 rounded-lg border p-6 text-center">
        <span className="bg-destructive/10 text-destructive flex size-10 items-center justify-center rounded-full">
          <AlertTriangleIcon className="size-5" />
        </span>
        <h2 className="text-sm font-medium">Yukino could not start</h2>
        <p className="text-muted-foreground text-xs leading-relaxed whitespace-pre-wrap">
          {init.error}
        </p>
        {init.configPath ? (
          <code className="bg-muted rounded-md px-2 py-1 font-mono text-xs">
            {init.configPath}
          </code>
        ) : null}
      </div>
    </div>
  );
}

function App(): React.JSX.Element {
  const chat = useChat();
  const { state } = chat;
  const init = state.init;
  const failed = init !== null && !init.ok;
  const booting = state.initializing && init === null;

  return (
    <TooltipProvider>
      <MessageScrollerProvider>
        <div className="bg-background flex h-full min-h-0 flex-col">
          <Header
            cwd={init?.ok ? init.cwd : null}
            model={init?.ok ? init.model : null}
            sessions={state.sessions}
            onNewSession={chat.startNewSession}
            onResumeSession={chat.resumeSession}
            onChooseFolder={chat.chooseFolder}
            refreshSessions={chat.refreshSessions}
            themeMode={chat.themeMode}
            onThemeMode={chat.setThemeMode}
          />

          {failed ? (
            <InitFailure init={init as InitState & { ok: false }} />
          ) : (
            <>
              <div className="relative flex min-h-0 flex-1 flex-col">
                {booting || state.items.length === 0 ? (
                  <div className="flex min-h-0 flex-1 flex-col items-center justify-center">
                    {booting ? (
                      <span className="text-muted-foreground flex items-center gap-2 text-sm">
                        <Spinner /> Starting agent…
                      </span>
                    ) : (
                      <EmptyState onHint={chat.send} />
                    )}
                  </div>
                ) : null}

                <MessageScroller
                  className={state.items.length === 0 ? "hidden" : "flex"}
                >
                  <MessageScrollerViewport className="mx-auto w-full max-w-3xl py-6">
                    <MessageScrollerContent>
                      {state.items.map((item) => (
                        <ChatItemRow
                          key={item.id}
                          item={item}
                          onRespondPermission={chat.respondPermission}
                          onRespondAsk={chat.respondAsk}
                        />
                      ))}
                      {state.streaming ? (
                        <div className="text-muted-foreground flex items-center gap-2 px-5 text-xs">
                          <Spinner />
                          {state.activeSubagents > 0
                            ? `${state.activeSubagents} subagent${state.activeSubagents > 1 ? "s" : ""} working…`
                            : "Working…"}
                        </div>
                      ) : null}
                    </MessageScrollerContent>
                  </MessageScrollerViewport>
                  <MessageScrollerButton />
                </MessageScroller>
              </div>

              <Separator />

              <footer className="shrink-0 px-4 pt-3 pb-4">
                <div className="mx-auto flex w-full max-w-3xl flex-col gap-2">
                  <Composer
                    streaming={state.streaming}
                    disabled={booting || failed || !init}
                    onSend={chat.send}
                    onAbort={chat.abort}
                  />
                  <div className="text-muted-foreground flex items-center justify-between px-1 text-[11px]">
                    <span className="truncate">
                      {init?.ok
                        ? `${init.providerName} · ${init.permissionMode === "default" ? "approval on tools" : init.permissionMode}`
                        : ""}
                    </span>
                    {state.usage ? (
                      <span className="shrink-0 tabular-nums">
                        {formatTokens(state.usage.inputTokens)} in ·{" "}
                        {formatTokens(state.usage.outputTokens)} out
                      </span>
                    ) : null}
                  </div>
                </div>
              </footer>
            </>
          )}
        </div>
      </MessageScrollerProvider>
    </TooltipProvider>
  );
}

export default App;

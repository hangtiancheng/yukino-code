// App shell: collapsible session sidebar, header, virtualized chat surface,
// and a composer floating at the bottom. The chat scroll viewport extends to
// the window's bottom and right edges so the scrollbar sits at the very edge
// of the app, not inside the content column. All agent state lives in the
// useChat hook; this file is presentation only.

import { ChatArea } from "@renderer/components/chat/chat-area";
import { Composer } from "@renderer/components/chat/composer";
import { EmptyState } from "@renderer/components/chat/empty-state";
import { Header } from "@renderer/components/chat/header";
import { SettingsDialog } from "@renderer/components/chat/settings-dialog";
import { Sidebar } from "@renderer/components/chat/sidebar";
import { Spinner } from "@renderer/components/ui/spinner";
import { Toaster } from "@renderer/components/ui/toaster";
import { TooltipProvider } from "@renderer/components/ui/tooltip";
import { useChat } from "@renderer/hooks/use-chat";
import type { InitState } from "@shared/ipc-types";
import { AlertTriangleIcon } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) {
    return `${(tokens / 1_000_000).toFixed(1)}M`;
  }
  if (tokens >= 1_000) {
    return `${(tokens / 1_000).toFixed(1)}k`;
  }
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
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const hasItems = state.items.length > 0;

  // The floating composer overlay has a dynamic height (auto-growing
  // textarea, conditional usage row). Measure it so ChatArea can park the
  // scroll-to-latest button just above it instead of behind it.
  const overlayRef = useRef<HTMLDivElement>(null);
  const [overlayHeight, setOverlayHeight] = useState(0);
  useLayoutEffect(() => {
    const element = overlayRef.current;
    if (!element) {
      return;
    }
    const observer = new ResizeObserver(() => {
      setOverlayHeight(element.offsetHeight);
    });
    observer.observe(element);
    setOverlayHeight(element.offsetHeight);
    return () => {
      observer.disconnect();
    };
  }, [hasItems]);

  return (
    <TooltipProvider>
      <div className="bg-background flex h-full min-w-0">
        <Sidebar
          open={sidebarOpen}
          sessions={state.sessions}
          activeSessionId={state.activeSessionId}
          currentProjectKey={state.init?.ok ? state.init.projectKey : null}
          onResumeSession={chat.resumeSession}
          onClose={() => {
            setSidebarOpen(false);
          }}
        />

        <div className="flex h-full min-w-0 flex-1 flex-col">
          <Header
            cwd={init?.ok ? init.cwd : null}
            sidebarOpen={sidebarOpen}
            onToggleSidebar={() => {
              setSidebarOpen((open) => !open);
            }}
            onNewSession={chat.startNewSession}
            onChooseFolder={chat.chooseFolder}
            themeMode={chat.themeMode}
            onThemeMode={chat.setThemeMode}
            onOpenSettings={() => {
              setSettingsOpen(true);
            }}
          />

          {failed ? (
            <InitFailure init={init} />
          ) : booting ? (
            <div className="flex min-h-0 flex-1 items-center justify-center">
              <span className="text-muted-foreground flex items-center gap-2 text-sm">
                <Spinner /> Starting agent…
              </span>
            </div>
          ) : hasItems ? (
            // Scroll viewport fills the column down to the window edge; the
            // composer floats above its bottom. Must stay a flex column so
            // ChatArea's flex-1 scroll viewport gets a bounded height.
            <div className="relative flex min-h-0 flex-1 flex-col">
              <ChatArea
                items={state.items}
                streaming={state.streaming}
                activeSubagents={state.activeSubagents}
                overlayHeight={overlayHeight}
                onRespondPermission={chat.respondPermission}
                onRespondAsk={chat.respondAsk}
              />
              <div
                ref={overlayRef}
                className="from-background via-background/95 pointer-events-none absolute inset-x-0 bottom-0 flex flex-col gap-2 bg-linear-to-t pt-6 pb-4"
              >
                <div className="pointer-events-auto mx-auto w-full max-w-4xl px-4">
                  <Composer
                    streaming={state.streaming}
                    disabled={booting || failed || !init}
                    onSend={chat.send}
                    onAbort={chat.abort}
                  />
                  {state.usage ? (
                    <div className="text-muted-foreground mt-2 flex justify-end px-1 text-[11px]">
                      <span className="shrink-0 tabular-nums">
                        {formatTokens(state.usage.inputTokens)} in ·{" "}
                        {formatTokens(state.usage.outputTokens)} out
                      </span>
                    </div>
                  ) : null}
                </div>
              </div>
            </div>
          ) : (
            // Empty conversation: centered hero + static composer.
            <>
              <div className="flex min-h-0 flex-1 flex-col items-center justify-center">
                <EmptyState />
              </div>
              <footer className="shrink-0 px-4 pt-3 pb-4">
                <div className="mx-auto w-full max-w-4xl">
                  <Composer
                    streaming={state.streaming}
                    disabled={booting || failed || !init}
                    onSend={chat.send}
                    onAbort={chat.abort}
                  />
                </div>
              </footer>
            </>
          )}
        </div>
      </div>

      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
      <Toaster />
    </TooltipProvider>
  );
}

export default App;

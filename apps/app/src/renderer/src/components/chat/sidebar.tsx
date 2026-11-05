// Collapsible left sidebar listing conversation history across ALL projects
// (ordered by the last user message, as returned by the bridge). Rows from
// other folders carry a project label; resuming one switches the working
// directory. The top strip is a window drag region that reserves space for
// the macOS traffic lights, which sit over the sidebar when it is expanded.

import { Button } from "@renderer/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@renderer/components/ui/tooltip";
import { folderName } from "@renderer/lib/utils";
import type { SessionSummary } from "@shared/ipc-types";
import { cn } from "cn";
import {
  FolderIcon,
  PanelLeftIcon,
  SnowflakeIcon,
  PlusIcon,
  SearchIcon,
  MessageSquareIcon,
} from "lucide-react";
import { useState } from "react";

function relativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const minutes = Math.round(diff / 60_000);
  if (minutes < 1) {
    return "now";
  }
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  return `${Math.round(hours / 24)}d ago`;
}

/** Ordering key: last real user message when known, file mtime otherwise. */
function sessionTime(session: SessionSummary): number {
  return session.lastUserMessageTime ?? session.modTime;
}

export function Sidebar({
  open,
  sessions,
  activeSessionId,
  currentProjectKey,
  onResumeSession,
  onClose,
  onNewSession,
  disabled,
}: {
  open: boolean;
  sessions: SessionSummary[];
  activeSessionId: string | null;
  /** Project key of the active chat; used to flag foreign sessions. */
  currentProjectKey: string | null;
  onResumeSession: (sessionId: string, cwd?: string) => void;
  onClose: () => void;
  onNewSession: () => void;
  disabled: boolean;
}): React.JSX.Element {
  const [search, setSearch] = useState("");
  const visible = sessions.filter((session) =>
    `${session.firstMessage} ${session.cwd}`
      .toLowerCase()
      .includes(search.toLowerCase()),
  );
  return (
    <aside
      className={cn(
        "border-border bg-card/40 relative flex h-full shrink-0 flex-col overflow-hidden border-r transition-[width,opacity] duration-200 ease-out",
        open ? "w-64 opacity-100" : "w-0 border-r-0 opacity-0",
      )}
      aria-hidden={!open}
      inert={!open}
    >
      {/* Drag strip clearing the traffic lights; close button on the right. */}
      <div className="titlebar-drag flex h-12 shrink-0 items-center justify-end pr-2 pl-21">
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                className="titlebar-no-drag"
                onClick={onClose}
                tabIndex={open ? 0 : -1}
              />
            }
          >
            <PanelLeftIcon />
            <span className="sr-only">收起会话</span>
          </TooltipTrigger>
          <TooltipContent>收起会话</TooltipContent>
        </Tooltip>
      </div>

      <div className="sidebar-brand">
        <span>
          <SnowflakeIcon />
        </span>
        <strong>Yukino</strong>
      </div>
      <div className="px-3 pb-4">
        <Button
          className="new-session-button w-full justify-start"
          variant="outline"
          disabled={disabled}
          onClick={onNewSession}
        >
          <PlusIcon />
          新建会话
          <span className="text-muted-foreground ml-auto text-[10px]">⌘ N</span>
        </Button>
        <div className="session-search">
          <SearchIcon />
          <input
            aria-label="搜索会话"
            placeholder="搜索会话"
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
            }}
          />
        </div>
      </div>
      <div className="flex h-8 shrink-0 items-center justify-between px-4">
        <span className="text-muted-foreground text-xs font-medium">
          最近会话
        </span>
        {sessions.length > 0 ? (
          <span className="text-muted-foreground text-xs tabular-nums">
            {sessions.length}
          </span>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 scrollbar-thin overflow-y-auto px-2 pb-3">
        {sessions.length === 0 ? (
          <p className="text-muted-foreground px-2 py-8 text-center text-xs">
            暂无会话
          </p>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {visible.map((session) => {
              const active = session.id === activeSessionId;
              const foreign =
                currentProjectKey !== null &&
                session.projectKey !== currentProjectKey;
              return (
                <li key={`${session.projectKey}/${session.id}`}>
                  <button
                    type="button"
                    disabled={!open || disabled}
                    onClick={() => {
                      onResumeSession(session.id, session.cwd);
                    }}
                    title={session.cwd}
                    className={cn(
                      "hover:bg-muted focus-visible:border-ring focus-visible:ring-ring/50 flex w-full flex-col items-start gap-0.5 rounded-md px-2.5 py-2 text-left transition-colors outline-none focus-visible:ring-3 disabled:pointer-events-none",
                      active && "bg-accent hover:bg-accent",
                    )}
                  >
                    <span
                      className={cn(
                        "line-clamp-1 w-full text-sm font-medium",
                        active && "text-accent-foreground",
                      )}
                    >
                      <MessageSquareIcon className="text-muted-foreground mr-1.5 inline size-3" />
                      {session.firstMessage || "新会话"}
                    </span>
                    <span className="text-muted-foreground flex w-full items-center gap-1 text-[11px]">
                      {foreign ? (
                        <>
                          <FolderIcon className="size-3 shrink-0" />
                          <span className="line-clamp-1 max-w-20 shrink-0 truncate">
                            {folderName(session.cwd)}
                          </span>
                          <span aria-hidden>·</span>
                        </>
                      ) : null}
                      <span className="shrink-0 tabular-nums">
                        {session.messageCount}{" "}
                        {session.messageCount === 1 ? "msg" : "msgs"}
                      </span>
                      <span aria-hidden>·</span>
                      <span className="shrink-0">
                        {relativeTime(sessionTime(session))}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </aside>
  );
}

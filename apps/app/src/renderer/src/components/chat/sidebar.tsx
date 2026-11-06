import { Button } from "@renderer/components/ui/button";
import { Input } from "@renderer/components/ui/input";
import { folderName } from "@renderer/lib/utils";
import type { SessionSummary } from "@shared/ipc-types";
import { cn } from "cn";
import {
  MessageSquareIcon,
  PanelLeftIcon,
  PlusIcon,
  SearchIcon,
  SnowflakeIcon,
} from "lucide-react";
import { useDeferredValue, useState } from "react";

function sessionTime(session: SessionSummary): number {
  return session.lastUserMessageTime ?? session.modTime;
}
function relativeTime(timestamp: number): string {
  const minutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60000));
  if (minutes < 1) {
    return "Just now";
  }
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  if (minutes < 1440) {
    return `${Math.floor(minutes / 60)}h ago`;
  }
  return `${Math.floor(minutes / 1440)}d ago`;
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
  currentProjectKey: string | null;
  onResumeSession: (sessionId: string, cwd?: string) => void;
  onClose: () => void;
  onNewSession: () => void;
  disabled: boolean;
}): React.JSX.Element {
  const [search, setSearch] = useState("");
  const query = useDeferredValue(search);
  const visible = sessions.filter((session) =>
    `${session.firstMessage} ${session.cwd}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  const today = new Date().setHours(0, 0, 0, 0);
  const groups = [
    {
      label: "Today",
      items: visible.filter((session) => sessionTime(session) >= today),
    },
    {
      label: "Yesterday",
      items: visible.filter(
        (session) =>
          sessionTime(session) < today &&
          sessionTime(session) >= today - 86400000,
      ),
    },
    {
      label: "Earlier",
      items: visible.filter(
        (session) => sessionTime(session) < today - 86400000,
      ),
    },
  ];
  return (
    <aside
      className={cn(
        "bg-sidebar relative flex h-full shrink-0 flex-col overflow-hidden transition-[width,opacity] duration-200",
        open
          ? "border-border w-[244px] border-r opacity-100 max-[1000px]:absolute max-[1000px]:z-40 max-[1000px]:shadow-[10px_0_40px_#132a4820]"
          : "w-0 border-r-0 opacity-0",
      )}
      aria-label="Session navigation"
      aria-hidden={!open}
      inert={!open}
    >
      <div className="flex min-h-12 items-center justify-end px-3 [-webkit-app-region:drag]">
        <Button
          variant="ghost"
          size="icon-sm"
          className="[-webkit-app-region:no-drag]"
          onClick={onClose}
          aria-label="Collapse sessions"
          title="Collapse sessions · ⌘ / Ctrl B"
        >
          <PanelLeftIcon />
        </Button>
      </div>
      <div className="flex items-center gap-2.5 px-[22px] pt-4 pb-7 whitespace-nowrap">
        <span className="bg-primary text-primary-foreground grid size-8 place-items-center rounded-[11px] shadow-[0_3px_9px_color-mix(in_srgb,var(--primary)_20%,transparent)]">
          <SnowflakeIcon className="size-[23px]" strokeWidth={1.6} />
        </span>
        <strong className="text-[25px] font-[650] tracking-[-1.2px]">
          yukino<span className="text-accent-foreground">.</span>
        </strong>
      </div>
      <div className="flex flex-col gap-[5px] px-3.5 pb-[22px]">
        <Button
          className="mb-[7px] h-[39px] w-full justify-start rounded-[9px] shadow-[0_2px_5px_#22193c0a]"
          disabled={disabled}
          onClick={onNewSession}
        >
          <PlusIcon />
          New session
          <kbd className="ml-auto text-[9px] font-normal opacity-60">
            ⌘ / Ctrl N
          </kbd>
        </Button>
      </div>
      <div className="text-muted-foreground flex justify-between px-6 text-[11px]">
        <span>Sessions</span>
        <span className="text-[10px] tabular-nums">{sessions.length}</span>
      </div>
      <div className="text-muted-foreground mx-5 mt-[11px] mb-[3px] flex items-center gap-[7px]">
        <SearchIcon className="size-[13px] shrink-0" />
        <Input
          className="placeholder:text-muted-foreground h-[27px] min-w-0 rounded-[5px] border-0 bg-transparent p-1 text-[11px] shadow-none focus-visible:shadow-[0_0_0_2px_var(--ring)] focus-visible:ring-0 focus-visible:outline-none md:text-[11px] dark:bg-transparent"
          aria-label="Search sessions"
          placeholder="Search sessions…"
          value={search}
          onChange={(event) => {
            setSearch(event.target.value);
          }}
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-4">
        {!visible.length ? (
          <p className="text-muted-foreground py-8 text-center text-[11px]">
            {search ? "No matching sessions" : "No sessions yet"}
          </p>
        ) : (
          groups.map((group) =>
            group.items.length ? (
              <div key={group.label}>
                <h3 className="text-muted-foreground px-[11px] pt-[13px] pb-[7px] text-[10px]">
                  {group.label}
                </h3>
                <ul>
                  {group.items.map((session) => {
                    const active = session.id === activeSessionId;
                    const foreign =
                      currentProjectKey !== null &&
                      session.projectKey !== currentProjectKey;
                    return (
                      <li key={`${session.projectKey}/${session.id}`}>
                        <button
                          type="button"
                          className={cn(
                            "hover:bg-accent/60 my-0.5 flex w-full items-start gap-[9px] rounded-[8px] px-[11px] py-2.5 text-left transition-colors",
                            active &&
                              "bg-accent text-accent-foreground hover:bg-accent",
                          )}
                          aria-current={active ? "page" : undefined}
                          disabled={disabled}
                          onClick={() => {
                            onResumeSession(session.id, session.cwd);
                          }}
                          title={session.cwd}
                        >
                          <MessageSquareIcon
                            className={cn(
                              "mt-0.5 size-3.5 shrink-0",
                              active
                                ? "text-accent-foreground"
                                : "text-muted-foreground",
                            )}
                          />
                          <span className="min-w-0 flex-1">
                            <strong className="block truncate text-xs font-medium">
                              {session.firstMessage || "New session"}
                            </strong>
                            <small className="text-muted-foreground block truncate pt-[5px] text-[10px]">
                              {foreign ? `${folderName(session.cwd)} · ` : ""}
                              {relativeTime(sessionTime(session))}
                            </small>
                          </span>
                          {active ? (
                            <span className="bg-primary mt-1.5 size-[5px] shrink-0 rounded-full" />
                          ) : null}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ) : null,
          )
        )}
      </div>
    </aside>
  );
}

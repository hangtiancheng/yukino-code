import { Button } from "@renderer/components/ui/button";
import { Input } from "@renderer/components/ui/input";
import { ChoiceSelect } from "@renderer/components/ui/select";
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
  const [scope, setScope] = useState<"all" | "project" | "archived">("all");
  const query = useDeferredValue(search).trim().toLowerCase();
  const scoped = sessions.filter((session) =>
    scope === "archived"
      ? session.archived
      : !session.archived &&
        (scope === "all" || session.projectKey === currentProjectKey),
  );
  const visible = scoped.filter((session) =>
    `${session.firstMessage} ${session.cwd} ${session.tags.join(" ")}`
      .toLowerCase()
      .includes(query),
  );
  const day = new Date();
  const today = day.setHours(0, 0, 0, 0);
  const yesterday = day.setDate(day.getDate() - 1);
  const groups = [
    {
      label: "Today",
      items: visible.filter((session) => sessionTime(session) >= today),
    },
    {
      label: "Yesterday",
      items: visible.filter(
        (session) =>
          sessionTime(session) < today && sessionTime(session) >= yesterday,
      ),
    },
    {
      label: "Earlier",
      items: visible.filter((session) => sessionTime(session) < yesterday),
    },
  ];
  return (
    <aside
      className={cn(
        "bg-sidebar relative flex h-full shrink-0 flex-col overflow-hidden transition-[width,opacity] duration-200",
        open
          ? "border-border w-[244px] border-r opacity-100 max-[1000px]:absolute max-[1000px]:z-40 max-[1000px]:shadow-[var(--dialog-shadow)]"
          : "w-0 border-r-0 opacity-0",
      )}
      aria-label="Session navigation"
      aria-hidden={!open}
      inert={!open}
    >
      <div className="mac:pl-21 flex min-h-14 items-center gap-2 border-b px-3.5 [-webkit-app-region:drag]">
        <span className="brand-mark" aria-hidden="true">
          <SnowflakeIcon className="size-5" strokeWidth={1.6} />
        </span>
        <strong className="text-[21px] leading-none font-semibold tracking-[-0.055em]">
          Yukino
        </strong>
        <Button
          variant="ghost"
          size="icon-sm"
          className="ml-auto [-webkit-app-region:no-drag]"
          onClick={onClose}
          aria-label="Collapse sessions"
          title="Collapse sessions · ⌘ / Ctrl B"
        >
          <PanelLeftIcon />
        </Button>
      </div>
      <div className="px-3.5 pt-4 pb-4">
        <Button
          className="h-9 w-full justify-start rounded-lg"
          disabled={disabled}
          onClick={onNewSession}
        >
          <PlusIcon />
          New session
          <kbd className="ml-auto shrink-0 rounded border border-current/10 px-1.5 py-0.5 text-[10px] font-normal opacity-70">
            <span className="mac:hidden">Ctrl N</span>
            <span className="mac:inline hidden">⌘ N</span>
          </kbd>
        </Button>
      </div>
      <div className="text-muted-foreground flex min-w-0 items-center justify-between gap-2 px-3.5 text-[11px]">
        <ChoiceSelect
          label="Session scope"
          value={scope}
          onValueChange={setScope}
          compact
          className="min-w-0 flex-1"
          options={[
            { value: "all", label: "All projects" },
            { value: "project", label: "Current project" },
            { value: "archived", label: "Archived" },
          ]}
        />
      </div>
      <div className="text-muted-foreground bg-card mx-3.5 mt-2 mb-2 flex items-center gap-1.5 rounded-lg border px-2">
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
            {search
              ? "No matching sessions"
              : scope === "archived"
                ? "No archived sessions"
                : "No sessions yet"}
          </p>
        ) : (
          groups.map((group) =>
            group.items.length ? (
              <div key={group.label}>
                <h3 className="text-muted-foreground px-2.5 pt-3 pb-1.5 text-[11px] font-medium">
                  {group.label}
                </h3>
                <ul>
                  {group.items.map((session) => {
                    const active =
                      session.id === activeSessionId &&
                      session.projectKey === currentProjectKey;
                    const foreign =
                      currentProjectKey !== null &&
                      session.projectKey !== currentProjectKey;
                    return (
                      <li key={`${session.projectKey}/${session.id}`}>
                        <button
                          type="button"
                          className={cn(
                            "session-row",
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
                            <small className="text-muted-foreground block truncate pt-1 text-[11px]">
                              {foreign ? `${folderName(session.cwd)} · ` : ""}
                              {relativeTime(sessionTime(session))}
                            </small>
                            {session.tags.length ? (
                              <small
                                className="text-accent-foreground block truncate pt-1 text-[10px]"
                                title={session.tags.join(", ")}
                              >
                                {session.tags.join(" · ")}
                              </small>
                            ) : null}
                          </span>
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

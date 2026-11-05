import { Button } from "@renderer/components/ui/button";
import { folderName } from "@renderer/lib/utils";
import type { SessionSummary } from "@shared/ipc-types";
import { cn } from "cn";
import {
  BoxesIcon,
  ChevronRightIcon,
  FolderIcon,
  MessageSquareIcon,
  PanelLeftIcon,
  PlusIcon,
  SearchIcon,
  Settings2Icon,
  SnowflakeIcon,
} from "lucide-react";
import { useDeferredValue, useState } from "react";

function sessionTime(session: SessionSummary): number {
  return session.lastUserMessageTime ?? session.modTime;
}
function relativeTime(timestamp: number): string {
  const minutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60000));
  if (minutes < 1) {
    return "刚刚";
  }
  if (minutes < 60) {
    return `${minutes} 分钟前`;
  }
  if (minutes < 1440) {
    return `${Math.floor(minutes / 60)} 小时前`;
  }
  return `${Math.floor(minutes / 1440)} 天前`;
}

export function Sidebar({
  open,
  sessions,
  activeSessionId,
  currentProjectKey,
  cwd,
  onResumeSession,
  onClose,
  onNewSession,
  onOpenCommands,
  onOpenRuntime,
  onOpenSettings,
  onChooseFolder,
  disabled,
}: {
  open: boolean;
  sessions: SessionSummary[];
  activeSessionId: string | null;
  currentProjectKey: string | null;
  cwd: string | null;
  onResumeSession: (sessionId: string, cwd?: string) => void;
  onClose: () => void;
  onNewSession: () => void;
  onOpenCommands: () => void;
  onOpenRuntime: () => void;
  onOpenSettings: () => void;
  onChooseFolder: () => void;
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
      label: "今天",
      items: visible.filter((session) => sessionTime(session) >= today),
    },
    {
      label: "昨天",
      items: visible.filter(
        (session) =>
          sessionTime(session) < today &&
          sessionTime(session) >= today - 86400000,
      ),
    },
    {
      label: "更早",
      items: visible.filter(
        (session) => sessionTime(session) < today - 86400000,
      ),
    },
  ];
  return (
    <aside
      className={cn("session-sidebar", open && "is-open")}
      aria-label="会话导航"
      aria-hidden={!open}
      inert={!open}
    >
      <div className="sidebar-titlebar titlebar-drag">
        <Button
          variant="ghost"
          size="icon-sm"
          className="titlebar-no-drag"
          onClick={onClose}
          aria-label="收起会话"
          title="收起会话 · ⌘ / Ctrl B"
        >
          <PanelLeftIcon />
        </Button>
      </div>
      <div className="sidebar-brand">
        <span>
          <SnowflakeIcon strokeWidth={1.6} />
        </span>
        <strong>
          yukino<span>.</span>
        </strong>
      </div>
      <div className="sidebar-actions">
        <Button
          className="new-session-button"
          disabled={disabled}
          onClick={onNewSession}
        >
          <PlusIcon />
          新建会话<kbd>⌘ / Ctrl N</kbd>
        </Button>
        <button
          className="sidebar-nav-button"
          onClick={onOpenCommands}
          aria-label="搜索命令"
        >
          <SearchIcon />
          <span>命令中心</span>
          <kbd>⌘ / Ctrl K</kbd>
        </button>
        <button
          className="sidebar-nav-button"
          onClick={onOpenRuntime}
          aria-label="打开工作台"
        >
          <BoxesIcon />
          <span>Agent 工作台</span>
          <ChevronRightIcon />
        </button>
      </div>
      <div className="sidebar-history-heading">
        <span>会话</span>
        <span>{sessions.length}</span>
      </div>
      <div className="session-search">
        <SearchIcon />
        <input
          aria-label="搜索会话"
          placeholder="搜索会话…"
          value={search}
          onChange={(event) => {
            setSearch(event.target.value);
          }}
        />
      </div>
      <div className="session-list">
        {!visible.length ? (
          <p className="session-empty">
            {search ? "没有匹配的会话" : "暂无会话"}
          </p>
        ) : (
          groups.map((group) =>
            group.items.length ? (
              <div key={group.label}>
                <h3 className="session-group-heading">{group.label}</h3>
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
                          className={cn("session-item", active && "active")}
                          aria-current={active ? "page" : undefined}
                          disabled={disabled}
                          onClick={() => {
                            onResumeSession(session.id, session.cwd);
                          }}
                          title={session.cwd}
                        >
                          <MessageSquareIcon />
                          <span className="min-w-0 flex-1">
                            <strong>{session.firstMessage || "新会话"}</strong>
                            <small>
                              {foreign ? `${folderName(session.cwd)} · ` : ""}
                              {relativeTime(sessionTime(session))}
                            </small>
                          </span>
                          {active ? (
                            <span className="session-active-dot" />
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
      <div className="sidebar-footer">
        <button
          className="sidebar-project"
          onClick={onChooseFolder}
          disabled={disabled}
          aria-label="切换项目"
          title={cwd ?? "打开项目"}
        >
          <span className="project-avatar">
            <FolderIcon />
          </span>
          <span>
            <strong>{cwd ? folderName(cwd) : "打开项目"}</strong>
            <small>{cwd ?? "选择工作目录"}</small>
          </span>
          <ChevronRightIcon />
        </button>
        <button
          className="sidebar-nav-button"
          onClick={onOpenSettings}
          aria-label="打开设置"
        >
          <Settings2Icon />
          <span>设置</span>
          <kbd>⌘ / Ctrl ,</kbd>
        </button>
      </div>
    </aside>
  );
}

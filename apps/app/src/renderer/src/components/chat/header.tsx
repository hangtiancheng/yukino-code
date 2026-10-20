// Top bar: workspace folder, new session, session history, and theme menu.
// Sits under the frameless title bar so the left edge leaves room for the
// macOS traffic lights.

import {
  FolderOpenIcon,
  HistoryIcon,
  MoonIcon,
  MonitorIcon,
  PlusIcon,
  SunIcon,
} from "lucide-react";
import type { SessionSummary } from "@shared/ipc-types";
import { Button } from "@renderer/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@renderer/components/ui/dropdown-menu";
import { Badge } from "@renderer/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@renderer/components/ui/tooltip";

function folderName(cwd: string): string {
  const parts = cwd.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? cwd;
}

function relativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const minutes = Math.round(diff / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export function Header({
  cwd,
  model,
  sessions,
  onNewSession,
  onResumeSession,
  onChooseFolder,
  refreshSessions,
  themeMode,
  onThemeMode,
}: {
  cwd: string | null;
  model: string | null;
  sessions: SessionSummary[];
  onNewSession(): void;
  onResumeSession(sessionId: string): void;
  onChooseFolder(): void;
  refreshSessions(): void;
  themeMode: "system" | "light" | "dark";
  onThemeMode(mode: "system" | "light" | "dark"): void;
}): React.JSX.Element {
  return (
    <header className="titlebar-drag border-border flex h-12 shrink-0 items-center gap-1 border-b px-4 pl-[76px]">
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="sm"
              onClick={onChooseFolder}
              className="titlebar-no-drag max-w-[220px] gap-1.5"
            />
          }
        >
          <FolderOpenIcon data-icon="inline-start" />
          <span className="truncate font-medium">
            {cwd ? folderName(cwd) : "Open folder"}
          </span>
        </TooltipTrigger>
        <TooltipContent>Choose project folder</TooltipContent>
      </Tooltip>

      {model ? (
        <Badge
          variant="outline"
          className="ml-1 max-w-[180px] truncate font-mono text-[10px]"
        >
          {model}
        </Badge>
      ) : null}

      <div className="titlebar-no-drag ml-auto flex items-center gap-1">
        <Tooltip>
          <TooltipTrigger
            render={
              <Button variant="ghost" size="icon-sm" onClick={onNewSession} />
            }
          >
            <PlusIcon />
            <span className="sr-only">New session</span>
          </TooltipTrigger>
          <TooltipContent>New session</TooltipContent>
        </Tooltip>

        <DropdownMenu
          onOpenChange={(open) => {
            if (open) refreshSessions();
          }}
        >
          <DropdownMenuTrigger
            render={<Button variant="ghost" size="icon-sm" />}
          >
            <HistoryIcon />
            <span className="sr-only">Session history</span>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            className="max-h-96 w-80 overflow-y-auto"
          >
            <DropdownMenuLabel>Recent sessions</DropdownMenuLabel>
            {sessions.length === 0 ? (
              <DropdownMenuItem disabled>No sessions yet</DropdownMenuItem>
            ) : (
              <DropdownMenuGroup>
                {sessions.map((session) => (
                  <DropdownMenuItem
                    key={session.id}
                    onClick={() => onResumeSession(session.id)}
                    className="flex flex-col items-start gap-0.5"
                  >
                    <span className="line-clamp-1 text-sm font-medium">
                      {session.firstMessage || session.id}
                    </span>
                    <span className="text-muted-foreground text-xs">
                      {session.messageCount} messages ·{" "}
                      {relativeTime(session.modTime)}
                    </span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuGroup>
            )}
          </DropdownMenuContent>
        </DropdownMenu>

        <DropdownMenu>
          <DropdownMenuTrigger
            render={<Button variant="ghost" size="icon-sm" />}
          >
            {themeMode === "light" ? (
              <SunIcon />
            ) : themeMode === "dark" ? (
              <MoonIcon />
            ) : (
              <MonitorIcon />
            )}
            <span className="sr-only">Theme</span>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuLabel>Appearance</DropdownMenuLabel>
            <DropdownMenuGroup>
              <DropdownMenuItem
                onClick={() => onThemeMode("system")}
                className="gap-2"
              >
                <MonitorIcon /> System
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => onThemeMode("light")}
                className="gap-2"
              >
                <SunIcon /> Light
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => onThemeMode("dark")}
                className="gap-2"
              >
                <MoonIcon /> Dark
              </DropdownMenuItem>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}

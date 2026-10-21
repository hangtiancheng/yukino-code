// Top bar: sidebar toggle, workspace folder, new session, and theme menu.
// Sits under the frameless title bar. When the sidebar is collapsed the
// header takes over the left edge, so it must clear the macOS traffic lights.

import { Button } from "@renderer/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@renderer/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@renderer/components/ui/tooltip";
import { cn } from "cn";
import {
  MoonIcon,
  MonitorIcon,
  PanelLeftIcon,
  PlusIcon,
  SettingsIcon,
  SunIcon,
} from "lucide-react";

function folderName(cwd: string): string {
  const parts = cwd.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? cwd;
}

export function Header({
  cwd,
  sidebarOpen,
  onToggleSidebar,
  onNewSession,
  onChooseFolder,
  themeMode,
  onThemeMode,
  onOpenSettings,
}: {
  cwd: string | null;
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
  onNewSession: () => void;
  onChooseFolder: () => void;
  themeMode: "system" | "light" | "dark";
  onThemeMode: (mode: "system" | "light" | "dark") => void;
  onOpenSettings: () => void;
}): React.JSX.Element {
  return (
    <header
      className={cn(
        "titlebar-drag border-border flex h-12 shrink-0 items-center gap-1 border-b px-4",
        // Traffic lights float over whichever element owns the left edge.
        sidebarOpen ? "pl-3" : "pl-21",
      )}
    >
      {/* Only the header opens the sidebar; closing is the sidebar's own button. */}
      {!sidebarOpen ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                className="titlebar-no-drag"
                onClick={onToggleSidebar}
              />
            }
          >
            <PanelLeftIcon />
            <span className="sr-only">Show sessions</span>
          </TooltipTrigger>
          <TooltipContent>Show sessions</TooltipContent>
        </Tooltip>
      ) : null}

      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="sm"
              onClick={onChooseFolder}
              className="titlebar-no-drag max-w-55"
            />
          }
        >
          <span className="bg-accent text-accent-foreground truncate rounded-md px-2 py-0.5 font-medium">
            {cwd ? folderName(cwd) : "Open folder"}
          </span>
        </TooltipTrigger>
        <TooltipContent>Choose project folder</TooltipContent>
      </Tooltip>

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

        <Tooltip>
          <TooltipTrigger
            render={
              <Button variant="ghost" size="icon-sm" onClick={onOpenSettings} />
            }
          >
            <SettingsIcon />
            <span className="sr-only">Settings</span>
          </TooltipTrigger>
          <TooltipContent>Settings</TooltipContent>
        </Tooltip>

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
            <DropdownMenuGroup>
              <DropdownMenuLabel>Appearance</DropdownMenuLabel>
              <DropdownMenuItem
                onClick={() => {
                  onThemeMode("system");
                }}
                className="gap-2"
              >
                <MonitorIcon /> System
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => {
                  onThemeMode("light");
                }}
                className="gap-2"
              >
                <SunIcon /> Light
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => {
                  onThemeMode("dark");
                }}
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

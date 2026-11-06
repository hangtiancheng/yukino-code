import { Button } from "@renderer/components/ui/button";
import type { InitState } from "@shared/ipc-types";
import {
  BoxesIcon,
  ChevronDownIcon,
  Code2Icon,
  FolderOpenIcon,
  PanelLeftIcon,
  Settings2Icon,
  SearchIcon,
  ChevronRightIcon,
} from "lucide-react";

export function Header({
  init,
  sidebarOpen,
  editorOpen,
  streaming,
  onToggleSidebar,
  onToggleEditor,
  onChooseFolder,
  onOpenSettings,
  onOpenRuntime,
  onOpenCommands,
  sessionTitle,
}: {
  init: InitState | null;
  sidebarOpen: boolean;
  editorOpen: boolean;
  streaming: boolean;
  onToggleSidebar: () => void;
  onToggleEditor: () => void;
  onChooseFolder: () => void;
  onOpenSettings: () => void;
  onOpenRuntime: () => void;
  onOpenCommands: () => void;
  sessionTitle: string;
}): React.JSX.Element {
  const cwd = init?.ok ? init.cwd : null;
  return (
    <header
      className={`border-border bg-background flex h-13.75 shrink-0 items-center gap-3 border-b px-5 [-webkit-app-region:drag] ${sidebarOpen ? "" : "mac:pl-21"}`}
    >
      {!sidebarOpen ? (
        <Button
          className="[-webkit-app-region:no-drag]"
          size="icon-sm"
          variant="ghost"
          aria-label="Show sessions"
          title="Show sessions · ⌘ B"
          onClick={onToggleSidebar}
        >
          <PanelLeftIcon />
        </Button>
      ) : null}
      <button
        className="flex max-w-[30%] items-center gap-2 text-xs font-[550] [-webkit-app-region:no-drag]"
        title={cwd ?? "Choose project"}
        disabled={streaming}
        onClick={onChooseFolder}
      >
        <FolderOpenIcon className="text-muted-foreground size-3.75 shrink-0" />
        <span className="truncate">
          {cwd ? cwd.split(/[\\/]/u).filter(Boolean).pop() : "Open project"}
        </span>
        <ChevronDownIcon className="size-3" />
      </button>
      <ChevronRightIcon className="text-input size-3 shrink-0" />
      <span className="text-muted-foreground max-w-[28%] truncate text-[11px]">
        {sessionTitle}
      </span>

      <div className="ml-auto flex items-center gap-1 [-webkit-app-region:no-drag]">
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onOpenCommands}
          aria-label="Command center"
          title="Command center · ⌘ / Ctrl K"
        >
          <SearchIcon />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onOpenRuntime}
          disabled={!init?.ok}
          aria-label="Agent workbench"
          title="Tasks and capabilities"
        >
          <BoxesIcon />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onOpenSettings}
          aria-label="Settings"
          title="Settings · ⌘ ,"
        >
          <Settings2Icon />
        </Button>
        <span className="bg-border mx-1 h-4 w-px shrink-0" />
        <Button
          variant={editorOpen ? "secondary" : "ghost"}
          size="sm"
          onClick={onToggleEditor}
          disabled={!init?.ok}
          aria-pressed={editorOpen}
          title="Toggle code workspace · ⌘ J"
        >
          <Code2Icon />
          <span className="hidden sm:inline">Code</span>
        </Button>
      </div>
    </header>
  );
}

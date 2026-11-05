import { Button } from "@renderer/components/ui/button";
import type { InitState } from "@shared/ipc-types";
import {
  BoxesIcon,
  ChevronDownIcon,
  Code2Icon,
  FolderOpenIcon,
  MoonIcon,
  PanelLeftIcon,
  Settings2Icon,
  SunIcon,
  SearchIcon,
  ChevronRightIcon,
} from "lucide-react";

export function Header({
  init,
  sidebarOpen,
  editorOpen,
  dark,
  streaming,
  onToggleSidebar,
  onToggleEditor,
  onChooseFolder,
  onThemeMode,
  onOpenSettings,
  onOpenRuntime,
  onOpenCommands,
  sessionTitle,
}: {
  init: InitState | null;
  sidebarOpen: boolean;
  editorOpen: boolean;
  dark: boolean;
  streaming: boolean;
  onToggleSidebar: () => void;
  onToggleEditor: () => void;
  onChooseFolder: () => void;
  onThemeMode: (mode: "system" | "light" | "dark") => void;
  onOpenSettings: () => void;
  onOpenRuntime: () => void;
  onOpenCommands: () => void;
  sessionTitle: string;
}): React.JSX.Element {
  const cwd = init?.ok ? init.cwd : null;
  return (
    <header
      className={`workspace-header titlebar-drag ${sidebarOpen ? "" : "traffic-clear"}`}
    >
      {!sidebarOpen ? (
        <Button
          className="titlebar-no-drag"
          size="icon-sm"
          variant="ghost"
          aria-label="显示会话"
          title="显示会话 · ⌘ B"
          onClick={onToggleSidebar}
        >
          <PanelLeftIcon />
        </Button>
      ) : null}
      <button
        className="project-selector titlebar-no-drag"
        title={cwd ?? "选择项目"}
        disabled={streaming}
        onClick={onChooseFolder}
      >
        <FolderOpenIcon />
        <span>
          {cwd ? cwd.split(/[\\/]/u).filter(Boolean).pop() : "打开项目"}
        </span>
        <ChevronDownIcon className="size-3" />
      </button>
      <ChevronRightIcon className="header-breadcrumb-icon" />
      <span className="header-session-title">{sessionTitle}</span>

      <div className="titlebar-no-drag ml-auto flex items-center gap-1">
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onOpenCommands}
          aria-label="命令中心"
          title="命令中心 · ⌘ / Ctrl K"
        >
          <SearchIcon />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onOpenRuntime}
          aria-label="Agent 工作台"
          title="任务与能力"
        >
          <BoxesIcon />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => {
            onThemeMode(dark ? "light" : "dark");
          }}
          aria-label={dark ? "切换浅色主题" : "切换深色主题"}
          title="切换主题"
        >
          {dark ? <SunIcon /> : <MoonIcon />}
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onOpenSettings}
          aria-label="设置"
          title="设置 · ⌘ ,"
        >
          <Settings2Icon />
        </Button>
        <span className="header-divider mx-1" />
        <Button
          variant={editorOpen ? "secondary" : "ghost"}
          size="sm"
          onClick={onToggleEditor}
          aria-pressed={editorOpen}
          title="切换代码工作区 · ⌘ J"
        >
          <Code2Icon />
          <span className="hidden sm:inline">代码</span>
        </Button>
      </div>
    </header>
  );
}

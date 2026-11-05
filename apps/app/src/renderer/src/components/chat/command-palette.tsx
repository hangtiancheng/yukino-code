import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@renderer/components/ui/dialog";
import type { CommandSummary } from "@shared/ipc-types";
import { useQuery } from "@tanstack/react-query";
import { Command } from "cmdk";
import {
  ArrowUpRightIcon,
  BoxesIcon,
  Code2Icon,
  FolderOpenIcon,
  PlusIcon,
  SearchIcon,
  Settings2Icon,
  TerminalIcon,
} from "lucide-react";

export function CommandPalette({
  open,
  onOpenChange,
  disabled,
  onCommand,
  onDraft,
  onNewSession,
  onChooseFolder,
  onOpenSettings,
  onOpenRuntime,
  onToggleEditor,
}: {
  open: boolean;
  onOpenChange: (value: boolean) => void;
  disabled: boolean;
  onCommand: (value: string) => void;
  onDraft: (value: string) => void;
  onNewSession: () => void;
  onChooseFolder: () => void;
  onOpenSettings: () => void;
  onOpenRuntime: () => void;
  onToggleEditor: () => void;
}): React.JSX.Element {
  const commands = useQuery({
    queryKey: ["commands"],
    queryFn: () => window.api.listCommands(),
    enabled: open,
    staleTime: 0,
  });
  const select = (action: () => void): void => {
    onOpenChange(false);
    action();
  };
  const chooseCommand = (command: CommandSummary): void => {
    select(() => {
      if (
        command.type === "prompt" ||
        command.type === "skill_fork" ||
        command.name === "goal"
      ) {
        onDraft(`/${command.name} `);
      } else {
        onCommand(`/${command.name}`);
      }
    });
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="command-dialog p-0 sm:max-w-xl"
        showCloseButton={false}
      >
        <DialogTitle className="sr-only">命令中心</DialogTitle>
        <DialogDescription className="sr-only">
          搜索操作、命令和技能
        </DialogDescription>
        <Command label="命令中心" loop>
          <div className="command-search">
            <SearchIcon />
            <Command.Input placeholder="搜索操作、命令、技能…" autoFocus />
            <kbd>ESC</kbd>
          </div>
          <Command.List>
            <Command.Empty>
              {commands.isPending ? "正在加载…" : "没有匹配的操作"}
            </Command.Empty>
            <Command.Group heading="工作区">
              {[
                {
                  name: "新建会话",
                  icon: PlusIcon,
                  action: onNewSession,
                  shortcut: "N",
                  blocked: disabled,
                },
                {
                  name: "打开项目",
                  icon: FolderOpenIcon,
                  action: onChooseFolder,
                  blocked: disabled,
                },
                {
                  name: "Agent 工作台",
                  icon: BoxesIcon,
                  action: onOpenRuntime,
                },
                {
                  name: "切换代码工作区",
                  icon: Code2Icon,
                  action: onToggleEditor,
                  shortcut: "J",
                },
                {
                  name: "设置",
                  icon: Settings2Icon,
                  action: onOpenSettings,
                  shortcut: ",",
                },
              ].map((item) => (
                <Command.Item
                  key={item.name}
                  onSelect={() => {
                    select(item.action);
                  }}
                  disabled={item.blocked}
                >
                  <item.icon />
                  <span>{item.name}</span>
                  {item.shortcut ? (
                    <kbd>⌘ / Ctrl {item.shortcut}</kbd>
                  ) : (
                    <ArrowUpRightIcon className="ml-auto" />
                  )}
                </Command.Item>
              ))}
            </Command.Group>
            {commands.error ? (
              <p role="alert" className="text-destructive px-4 py-2 text-xs">
                {commands.error.message}
              </p>
            ) : null}
            {(["命令", "Skills"] as const).map((group) => (
              <Command.Group heading={group} key={group}>
                {(commands.data ?? [])
                  .filter((item) =>
                    group === "Skills" ? item.isSkill : !item.isSkill,
                  )
                  .map((command) => (
                    <Command.Item
                      key={command.name}
                      value={`/${command.name} ${command.description}`}
                      disabled={disabled}
                      onSelect={() => {
                        chooseCommand(command);
                      }}
                    >
                      <TerminalIcon />
                      <span className="command-name">
                        /{command.name}
                        <small>{command.description}</small>
                      </span>
                      <ArrowUpRightIcon className="ml-auto" />
                    </Command.Item>
                  ))}
              </Command.Group>
            ))}
          </Command.List>
          <div className="command-footer">
            <span>↑ ↓ 选择</span>
            <span>↵ 打开</span>
          </div>
        </Command>
      </DialogContent>
    </Dialog>
  );
}

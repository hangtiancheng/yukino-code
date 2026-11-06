import {
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
} from "@renderer/components/ui/command";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@renderer/components/ui/dialog";
import type { CommandSummary } from "@shared/ipc-types";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowUpRightIcon,
  BoxesIcon,
  Code2Icon,
  FolderOpenIcon,
  PlusIcon,
  Settings2Icon,
  TerminalIcon,
} from "lucide-react";

export function CommandPalette({
  open,
  onOpenChange,
  busy,
  connected,
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
  busy: boolean;
  connected: boolean;
  onCommand: (value: string) => void;
  onDraft: (value: string) => void;
  onNewSession: () => void;
  onChooseFolder: () => void;
  onOpenSettings: () => void;
  onOpenRuntime: () => void;
  onToggleEditor: () => void;
}): React.JSX.Element {
  const disabled = busy || !connected;
  const commands = useQuery({
    queryKey: ["commands"],
    queryFn: () => window.api.listCommands(),
    enabled: open && connected,
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
        className="flex max-h-[calc(100dvh-64px)] w-[min(600px,calc(100vw-32px))] flex-col gap-0 overflow-hidden p-0 shadow-[0_24px_100px_#17241b26] sm:max-w-xl"
        showCloseButton={false}
      >
        <DialogTitle className="sr-only">命令中心</DialogTitle>
        <DialogDescription className="sr-only">
          搜索操作、命令和技能
        </DialogDescription>
        <Command
          label="命令中心"
          loop
          className="[&_[cmdk-item][data-selected=true]]:bg-accent [&_[cmdk-item][data-selected=true]]:text-accent-foreground [&_[cmdk-item]_kbd]:text-muted-foreground **:data-[slot=command-input-wrapper]:border-border h-auto max-h-[calc(100dvh-64px)] min-h-0 min-w-0 p-1.5 **:data-[slot=command-input-wrapper]:shrink-0 **:data-[slot=command-input-wrapper]:border-b **:data-[slot=command-input-wrapper]:px-2 **:data-[slot=command-input-wrapper]:pt-2 **:data-[slot=command-input-wrapper]:pb-3 **:data-[slot=input-group]:h-10! **:data-[slot=input-group]:min-h-10 **:data-[slot=input-group]:flex-nowrap [&_[cmdk-item]_kbd]:ml-auto [&_[cmdk-item]_kbd]:text-[10px] [&_[cmdk-item]>svg]:shrink-0 **:[[cmdk-input]]:block **:[[cmdk-input]]:h-full **:[[cmdk-input]]:w-full **:[[cmdk-input]]:min-w-0 **:[[cmdk-input]]:flex-1 **:[[cmdk-input]]:bg-transparent **:[[cmdk-input]]:pr-3 **:[[cmdk-input]]:text-sm **:[[cmdk-input]]:outline-none **:[[cmdk-item]]:min-h-10 **:[[cmdk-item]]:px-3 **:[[cmdk-item]]:py-2.5"
        >
          <CommandInput
            placeholder="搜索操作、命令、技能…"
            autoFocus
            aria-label="搜索操作、命令、技能"
          />
          <CommandList className="max-h-[min(440px,55dvh)] min-h-0 flex-1 overflow-y-auto overscroll-contain py-1.5">
            <CommandEmpty>
              {commands.isPending ? "正在加载…" : "没有匹配的操作"}
            </CommandEmpty>
            <CommandGroup heading="工作区">
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
                  blocked: busy,
                },
                {
                  name: "Agent 工作台",
                  icon: BoxesIcon,
                  action: onOpenRuntime,
                  blocked: !connected,
                },
                {
                  name: "切换代码工作区",
                  icon: Code2Icon,
                  action: onToggleEditor,
                  blocked: !connected,
                  shortcut: "J",
                },
                {
                  name: "设置",
                  icon: Settings2Icon,
                  action: onOpenSettings,
                  shortcut: ",",
                },
              ].map((item) => (
                <CommandItem
                  key={item.name}
                  value={item.name}
                  onSelect={() => {
                    select(item.action);
                  }}
                  disabled={item.blocked}
                >
                  <item.icon />
                  <span className="min-w-0 flex-1 truncate">{item.name}</span>
                  {item.shortcut ? (
                    <kbd>⌘ / Ctrl {item.shortcut}</kbd>
                  ) : (
                    <ArrowUpRightIcon className="ml-auto" />
                  )}
                </CommandItem>
              ))}
            </CommandGroup>
            {commands.error ? (
              <p role="alert" className="text-destructive px-4 py-2 text-xs">
                {commands.error.message}
              </p>
            ) : null}
            {(["命令", "Skills"] as const).map((group) => (
              <CommandGroup heading={group} key={group}>
                {(commands.data ?? [])
                  .filter((item) =>
                    group === "Skills" ? item.isSkill : !item.isSkill,
                  )
                  .map((command) => (
                    <CommandItem
                      key={command.name}
                      value={`/${command.name} ${command.description}`}
                      disabled={disabled}
                      onSelect={() => {
                        chooseCommand(command);
                      }}
                    >
                      <TerminalIcon />
                      <span className="flex min-w-0 flex-1 flex-col gap-[3px]">
                        <span className="truncate">/{command.name}</span>
                        <small className="text-muted-foreground block truncate text-[10px]">
                          {command.description}
                        </small>
                      </span>
                      <ArrowUpRightIcon className="ml-auto" />
                    </CommandItem>
                  ))}
              </CommandGroup>
            ))}
          </CommandList>
          <div className="border-border bg-background text-muted-foreground flex shrink-0 gap-4 border-t px-5 py-[11px] text-[10px]">
            <span>↑ ↓ 选择</span>
            <span>↵ 打开</span>
            <span className="ml-auto">esc 关闭</span>
          </div>
        </Command>
      </DialogContent>
    </Dialog>
  );
}

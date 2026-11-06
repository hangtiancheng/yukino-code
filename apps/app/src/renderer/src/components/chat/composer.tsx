// The message input: auto-growing textarea, Enter to send, Shift+Enter for a
// newline, and a Send/Stop button that reflects streaming state. Typing "/"
// at the start of a space-free input summons the slash command panel; arrow
// keys navigate it, Tab/Enter insert (or run) the highlighted command.

import { Button } from "@renderer/components/ui/button";
import { ChoiceSelect } from "@renderer/components/ui/select";
import { Textarea } from "@renderer/components/ui/textarea";
import type { CommandSummary } from "@shared/ipc-types";
import { cn } from "cn";
import {
  ArrowUpIcon,
  CornerDownLeftIcon,
  SquareIcon,
  PaperclipIcon,
  XIcon,
  ChevronDownIcon,
  CpuIcon,
  ShieldCheckIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

function filterCommands(
  commands: CommandSummary[],
  query: string,
): CommandSummary[] {
  if (!query) {
    return commands;
  }
  return commands.filter(
    (command) =>
      command.name.toLowerCase().includes(query) ||
      command.description.toLowerCase().includes(query),
  );
}

export function Composer({
  streaming,
  disabled,
  onSend,
  onAbort,
  draft,
  model,
  permissionMode,
  onOpenSettings,
  onPermissionMode,
}: {
  streaming: boolean;
  disabled: boolean;
  onSend: (text: string) => void;
  onAbort: () => void;
  draft: { text: string; id: number } | null;
  model: string;
  permissionMode: string;
  onOpenSettings: () => void;
  onPermissionMode: (
    mode: "default" | "acceptEdits" | "plan" | "bypassPermissions",
  ) => void;
}): React.JSX.Element {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [commands, setCommands] = useState<CommandSummary[]>([]);
  const [query, setQuery] = useState<string | null>(null);
  const [highlighted, setHighlighted] = useState(0);
  const panelOpen = query !== null;
  const [attachments, setAttachments] = useState<string[]>([]);
  const [hasText, setHasText] = useState(false);

  useEffect(() => {
    if (!draft) {
      return;
    }
    const frame = requestAnimationFrame(() => {
      if (ref.current) {
        ref.current.value = draft.text;
        ref.current.focus();
        ref.current.selectionStart = ref.current.value.length;
        ref.current.selectionEnd = ref.current.value.length;
        setHasText(Boolean(draft.text.trim()));
      }
    });
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [draft]);

  useEffect(() => {
    if (!panelOpen) {
      return;
    }
    void window.api
      .listCommands()
      .then(setCommands)
      .catch((error: unknown) => toast.error(String(error)));
  }, [panelOpen]);

  const matches = useMemo(
    () => (query === null ? [] : filterCommands(commands, query)),
    [commands, query],
  );

  /** Panel is open while the input is a bare "/query" token (no spaces). */
  const syncPanel = useCallback(() => {
    const textarea = ref.current;
    if (!textarea) {
      return;
    }
    const value = textarea.value;
    const isSlash = value.startsWith("/") && !/\s/.test(value);
    setQuery(isSlash ? value.slice(1).toLowerCase() : null);
    setHighlighted(0);
  }, []);

  const insertCommand = useCallback((command: CommandSummary) => {
    const textarea = ref.current;
    if (!textarea) {
      return;
    }
    textarea.value = `/${command.name} `;
    textarea.focus();
    setHasText(true);
    setQuery(null);
  }, []);

  const submit = useCallback(() => {
    if (disabled) {
      return;
    }
    const textarea = ref.current;
    if (!textarea) {
      return;
    }
    const text = [
      textarea.value.trim(),
      ...attachments.map((path) => `@"${path}"`),
    ]
      .filter(Boolean)
      .join("\n");
    if (!text) {
      return;
    }
    onSend(text);
    textarea.value = "";
    textarea.style.height = "auto";
    setQuery(null);
    setAttachments([]);
    setHasText(false);
  }, [onSend, attachments, disabled]);

  return (
    <div className="composer-shell relative">
      {attachments.length ? (
        <div className="flex flex-wrap gap-1 px-3 pt-3">
          {attachments.map((path) => (
            <span className="attachment-chip" key={path}>
              <PaperclipIcon className="size-3" />
              <span className="max-w-40 truncate" title={path}>
                {path.split(/[\\/]/u).pop()}
              </span>
              <button
                aria-label={`移除 ${path}`}
                onClick={() => {
                  setAttachments((current) =>
                    current.filter((item) => item !== path),
                  );
                }}
              >
                <XIcon className="size-3" />
              </button>
            </span>
          ))}
        </div>
      ) : null}
      <div className="flex items-end gap-2 px-3 pt-3">
        {query !== null && matches.length > 0 ? (
          <div
            role="listbox"
            aria-label="命令"
            className="border-border bg-popover absolute bottom-full left-0 z-20 mb-2 max-h-72 w-full overflow-y-auto rounded-lg border py-1 shadow-lg"
          >
            {matches.map((command, index) => (
              <button
                key={command.name}
                type="button"
                role="option"
                aria-selected={index === highlighted}
                className={cn(
                  "flex w-full items-baseline gap-2 px-3 py-1.5 text-left text-sm",
                  index === highlighted ? "bg-accent" : "hover:bg-accent/50",
                )}
                onMouseEnter={() => {
                  setHighlighted(index);
                }}
                // preventDefault keeps textarea focus; click inserts the command.
                onMouseDown={(event) => {
                  event.preventDefault();
                }}
                onClick={() => {
                  insertCommand(command);
                }}
              >
                <span className="shrink-0 font-mono text-xs font-medium">
                  /{command.name}
                </span>
                <span className="text-muted-foreground line-clamp-1 text-xs">
                  {command.description}
                </span>
                {index === highlighted ? (
                  <CornerDownLeftIcon className="text-muted-foreground ml-auto size-3 shrink-0 self-center" />
                ) : null}
              </button>
            ))}
          </div>
        ) : null}

        <Textarea
          ref={ref}
          rows={1}
          autoFocus
          aria-label="任务输入"
          placeholder={
            disabled
              ? "未连接"
              : streaming
                ? "补充要求，Agent 会在下一轮接收…"
                : "描述任务，或输入 / 选择技能…"
          }
          disabled={disabled}
          className="max-h-52 min-h-14 flex-1 resize-none overflow-y-auto border-0 bg-transparent px-1 py-1 shadow-none focus-visible:ring-0"
          onChange={(event) => {
            const textarea = event.currentTarget;
            textarea.style.height = "auto";
            textarea.style.height = `${Math.min(textarea.scrollHeight, 256)}px`;
            setHasText(Boolean(textarea.value.trim()));
            syncPanel();
          }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) {
              return;
            }
            if (query !== null && matches.length > 0) {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setHighlighted((value) => (value + 1) % matches.length);
                return;
              }
              if (event.key === "ArrowUp") {
                event.preventDefault();
                setHighlighted(
                  (value) => (value - 1 + matches.length) % matches.length,
                );
                return;
              }
              if (event.key === "Tab") {
                event.preventDefault();
                const command = matches[highlighted];
                if (command) {
                  insertCommand(command);
                }
                return;
              }
              if (event.key === "Escape") {
                event.preventDefault();
                setQuery(null);
                return;
              }
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                const command = matches[highlighted];
                // An exact match runs immediately; otherwise the highlighted
                // entry is inserted so arguments can be added before sending.
                if (command?.name === query) {
                  const textarea = ref.current;
                  if (textarea) {
                    textarea.value = `/${command.name}`;
                  }
                  submit();
                } else if (command) {
                  insertCommand(command);
                }
                return;
              }
            }
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              submit();
            }
          }}
        />
      </div>
      <div className="composer-toolbar">
        <Button
          variant="ghost"
          size="icon-sm"
          disabled={disabled}
          title="添加文件或图片"
          aria-label="添加文件或图片"
          onClick={() => {
            void window.api
              .selectAttachments()
              .then((paths) => {
                setAttachments((current) => [
                  ...new Set([...current, ...paths]),
                ]);
              })
              .catch((error: unknown) => toast.error(String(error)));
          }}
        >
          <PaperclipIcon />
        </Button>
        <span className="composer-toolbar-divider" />
        <button
          className="composer-model"
          onClick={onOpenSettings}
          disabled={streaming}
          title={model}
        >
          <CpuIcon />
          <span>{model}</span>
          <ChevronDownIcon />
        </button>
        <span className="mr-auto" />
        {streaming ? (
          <Button
            size="icon-sm"
            variant="secondary"
            onClick={onAbort}
            title="停止任务"
            aria-label="停止任务"
          >
            <SquareIcon className="size-3 fill-current" />
          </Button>
        ) : null}
        <Button
          size="sm"
          onClick={submit}
          disabled={disabled || (!hasText && !attachments.length)}
          className="send-button"
        >
          {streaming ? "补充" : "发送"}
          <ArrowUpIcon className="size-3.5" />
        </Button>
      </div>
      <div className="composer-options">
        <ChoiceSelect
          label="Agent 权限模式"
          value={
            permissionMode as
              "default" | "acceptEdits" | "plan" | "bypassPermissions"
          }
          disabled={streaming || disabled}
          onValueChange={onPermissionMode}
          compact
          icon={<ShieldCheckIcon />}
          className="permission-select"
          options={[
            { value: "default", label: "逐项授权" },
            { value: "acceptEdits", label: "自动接受编辑" },
            { value: "plan", label: "只读规划" },
            { value: "bypassPermissions", label: "允许所有工具" },
          ]}
        />
        <span>⇧ ↵ 换行</span>
      </div>
    </div>
  );
}

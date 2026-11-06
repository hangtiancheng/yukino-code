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
    <div className="border-input bg-card focus-within:border-ring relative rounded-[15px] border shadow-[0_4px_16px_#26173f06] transition-[border-color,box-shadow] focus-within:shadow-[0_0_0_3px_color-mix(in_srgb,var(--primary)_6%,transparent),0_5px_20px_#26173f05]">
      {attachments.length ? (
        <div className="flex flex-wrap gap-1 px-3 pt-3">
          {attachments.map((path) => (
            <span
              className="bg-secondary text-secondary-foreground inline-flex items-center gap-1.25 rounded-[6px] px-1.75 py-1 text-[11px]"
              key={path}
            >
              <PaperclipIcon className="size-3" />
              <span className="max-w-40 truncate" title={path}>
                {path.split(/[\\/]/u).pop()}
              </span>
              <button
                aria-label={`Remove ${path}`}
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
            aria-label="Commands"
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
          aria-label="Task input"
          placeholder={
            disabled
              ? "Not connected"
              : streaming
                ? "Add a follow-up requirement. The agent will receive it in the next turn…"
                : "Describe a task, or type / to choose a skill…"
          }
          disabled={disabled}
          className="max-h-52 min-h-18.5 flex-1 resize-none overflow-y-auto border-0 bg-transparent px-1 py-1 text-xs leading-[1.8] shadow-none focus-visible:ring-0 md:text-xs dark:bg-transparent"
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
      <div className="flex items-center gap-0.75 px-2.5 pt-1.25 pb-2.5">
        <Button
          variant="ghost"
          size="icon-sm"
          disabled={disabled}
          title="Add files or images"
          aria-label="Add files or images"
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
        <span className="bg-border mx-1.25 h-3.5 w-px" />
        <button
          className="text-muted-foreground hover:text-accent-foreground flex max-w-[48%] min-w-0 items-center gap-1.5 rounded-[5px] px-0.75 py-1.25 text-[10px] max-[1050px]:max-w-[38%]"
          onClick={onOpenSettings}
          disabled={streaming}
          title={model}
        >
          <CpuIcon className="size-3.25 shrink-0" />
          <span className="truncate">{model}</span>
          <ChevronDownIcon className="h-3.25 w-2.5 shrink-0" />
        </button>
        <span className="mr-auto" />
        {streaming ? (
          <Button
            size="icon-sm"
            variant="secondary"
            onClick={onAbort}
            title="Stop task"
            aria-label="Stop task"
          >
            <SquareIcon className="size-3 fill-current" />
          </Button>
        ) : null}
        <Button
          size="sm"
          onClick={submit}
          disabled={disabled || (!hasText && !attachments.length)}
          className="h-7.25 rounded-[8px] text-[11px]"
        >
          {streaming ? "Follow up" : "Send"}
          <ArrowUpIcon className="size-3.5" />
        </Button>
      </div>
      <div className="border-border bg-background text-muted-foreground flex items-center justify-between rounded-b-[14px] border-t px-3.25 py-2 text-[9px]">
        <ChoiceSelect
          label="Agent permission mode"
          value={
            permissionMode as
              "default" | "acceptEdits" | "plan" | "bypassPermissions"
          }
          disabled={streaming || disabled}
          onValueChange={onPermissionMode}
          compact
          icon={<ShieldCheckIcon />}
          className="text-foreground hover:bg-accent dark:hover:bg-accent h-6.5 max-w-47.5 border-transparent px-1.25 text-[11px]"
          options={[
            { value: "default", label: "Ask for each action" },
            { value: "acceptEdits", label: "Auto-accept edits" },
            { value: "plan", label: "Read-only planning" },
            { value: "bypassPermissions", label: "Allow all tools" },
          ]}
        />
        <span>⇧ ↵ for newline</span>
      </div>
    </div>
  );
}

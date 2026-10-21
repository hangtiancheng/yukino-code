// The message input: auto-growing textarea, Enter to send, Shift+Enter for a
// newline, and a Send/Stop button that reflects streaming state. Typing "/"
// at the start of a space-free input summons the slash command panel; arrow
// keys navigate it, Tab/Enter insert (or run) the highlighted command.

import { Button } from "@renderer/components/ui/button";
import { Textarea } from "@renderer/components/ui/textarea";
import type { CommandSummary } from "@shared/ipc-types";
import { cn } from "cn";
import { ArrowUpIcon, CornerDownLeftIcon, SquareIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

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
}: {
  streaming: boolean;
  disabled: boolean;
  onSend: (text: string) => void;
  onAbort: () => void;
}): React.JSX.Element {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [commands, setCommands] = useState<CommandSummary[]>([]);
  const [query, setQuery] = useState<string | null>(null);
  const [highlighted, setHighlighted] = useState(0);
  const commandsLoaded = useRef(false);

  // Lazy-load the command list the first time the panel would open.
  useEffect(() => {
    if (query === null || commandsLoaded.current) {
      return;
    }
    commandsLoaded.current = true;
    void window.api.listCommands().then(setCommands);
  }, [query]);

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
    setQuery(null);
  }, []);

  const submit = useCallback(() => {
    const textarea = ref.current;
    if (!textarea) {
      return;
    }
    const text = textarea.value.trim();
    if (!text) {
      return;
    }
    onSend(text);
    textarea.value = "";
    textarea.style.height = "auto";
    setQuery(null);
  }, [onSend]);

  return (
    <div className="relative flex items-end gap-2">
      {query !== null && matches.length > 0 ? (
        <div
          role="listbox"
          aria-label="Slash commands"
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
        placeholder={disabled ? "Starting up…" : "Message Yukino…"}
        disabled={disabled}
        className="max-h-64 min-h-10 flex-1 resize-none overflow-y-auto py-2.5"
        onChange={(event) => {
          const textarea = event.currentTarget;
          textarea.style.height = "auto";
          textarea.style.height = `${Math.min(textarea.scrollHeight, 256)}px`;
          syncPanel();
        }}
        onKeyDown={(event) => {
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
      {streaming ? (
        <Button
          size="icon"
          variant="secondary"
          onClick={onAbort}
          className="size-10 shrink-0"
        >
          <SquareIcon data-icon="inline-start" className="fill-current" />
          <span className="sr-only">Stop</span>
        </Button>
      ) : (
        <Button
          size="icon"
          onClick={submit}
          disabled={disabled}
          className="size-10 shrink-0"
        >
          <ArrowUpIcon data-icon="inline-start" />
          <span className="sr-only">Send</span>
        </Button>
      )}
    </div>
  );
}

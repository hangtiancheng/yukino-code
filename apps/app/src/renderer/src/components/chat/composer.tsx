// The message input: auto-growing textarea, Enter to send, Shift+Enter for a
// newline, and a Send/Stop button that reflects streaming state.

import { useCallback, useRef } from "react";
import { ArrowUpIcon, SquareIcon } from "lucide-react";
import { Button } from "@renderer/components/ui/button";
import { Textarea } from "@renderer/components/ui/textarea";

export function Composer({
  streaming,
  disabled,
  onSend,
  onAbort,
}: {
  streaming: boolean;
  disabled: boolean;
  onSend(text: string): void;
  onAbort(): void;
}): React.JSX.Element {
  const ref = useRef<HTMLTextAreaElement>(null);

  const submit = useCallback(() => {
    const textarea = ref.current;
    if (!textarea) return;
    const text = textarea.value.trim();
    if (!text) return;
    onSend(text);
    textarea.value = "";
    textarea.style.height = "auto";
  }, [onSend]);

  return (
    <div className="flex items-end gap-2">
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
        }}
        onKeyDown={(event) => {
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

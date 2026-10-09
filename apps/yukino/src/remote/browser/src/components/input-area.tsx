import type { SlashCommand } from "@browser/types";
import { useEffect, useMemo, useRef, useState } from "react";

import { SlashMenu } from "./slash-menu";

interface InputAreaProps {
  streaming: boolean;
  commands: SlashCommand[];
  /** Steering messages queued for the in-flight run. */
  steering: string[];
  onSend: (text: string) => void;
  onCancel: () => void;
}

const MAX_TEXTAREA_HEIGHT = 200;

/** Mirrors the server's slash-command parse: "/name ..." but not filesystem paths. */
function looksLikeCommand(text: string): boolean {
  if (!text.startsWith("/")) {
    return false;
  }
  const name = text.slice(1).trim().split(/\s/u)[0] ?? "";
  return name.length > 0 && !name.includes("/");
}

export function InputArea({
  streaming,
  commands,
  steering,
  onSend,
  onCancel,
}: InputAreaProps) {
  const [value, setValue] = useState("");
  const [slashOpen, setSlashOpen] = useState(false);
  const [slashCursor, setSlashCursor] = useState(0);
  const [blockedHint, setBlockedHint] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const blockedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const filtered = useMemo<SlashCommand[]>(() => {
    // Commands cannot run mid-stream; keep the menu closed while steering.
    if (streaming) {
      return [];
    }
    if (!value.startsWith("/") || value.includes(" ") || value.includes("\n")) {
      return [];
    }
    const prefix = value.slice(1).toLowerCase();
    return commands.filter((c) => c.name.toLowerCase().startsWith(prefix));
  }, [value, commands, streaming]);

  useEffect(() => {
    setSlashOpen(filtered.length > 0);
    setSlashCursor(0);
  }, [filtered]);

  // Auto-grow the textarea up to MAX_TEXTAREA_HEIGHT.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) {
      return;
    }
    el.style.height = "auto";
    el.style.height = `${String(Math.min(el.scrollHeight, MAX_TEXTAREA_HEIGHT))}px`;
  }, [value]);

  // Focus on mount and whenever streaming flips back to false.
  useEffect(() => {
    if (!streaming) {
      textareaRef.current?.focus();
    }
  }, [streaming]);

  useEffect(
    () => () => {
      if (blockedTimerRef.current) {
        clearTimeout(blockedTimerRef.current);
      }
    },
    [],
  );

  const flashHint = (message: string): void => {
    setBlockedHint(message);
    if (blockedTimerRef.current) {
      clearTimeout(blockedTimerRef.current);
    }
    blockedTimerRef.current = setTimeout(() => {
      setBlockedHint("");
    }, 4000);
  };

  const selectSlash = (index: number) => {
    const cmd = filtered[index];
    if (!cmd) {
      return;
    }
    setValue(`/${cmd.name} `);
    setSlashOpen(false);
    textareaRef.current?.focus();
  };

  const send = () => {
    const text = value.trim();
    if (!text) {
      return;
    }
    if (streaming && looksLikeCommand(text)) {
      // Matches the server behavior: slash commands cannot be steered into a
      // running turn, and they are not queued either — the user must resend
      // once the turn finishes.
      flashHint(
        "Commands cannot run mid-turn. Wait for the turn to finish, then resend.",
      );
      return;
    }
    onSend(text);
    setValue("");
    setSlashOpen(false);
    setBlockedHint("");
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (slashOpen) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSlashCursor((c) => Math.min(c + 1, filtered.length - 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSlashCursor((c) => Math.max(c - 1, 0));
        return;
      }
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
        e.preventDefault();
        selectSlash(slashCursor);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setSlashOpen(false);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  return (
    <footer className="shrink-0 border-t border-border bg-bg [padding-bottom:env(safe-area-inset-bottom)]">
      <div className="relative mx-auto w-full max-w-3xl px-3 py-3 sm:px-5 sm:py-4">
        {slashOpen && (
          <SlashMenu
            commands={filtered}
            cursor={slashCursor}
            onSelect={selectSlash}
            onHover={setSlashCursor}
          />
        )}
        {steering.length > 0 && (
          <div
            className="mb-2 flex flex-wrap gap-1.5"
            role="status"
            aria-label="Queued steering messages"
          >
            {steering.map((text, index) => (
              <span
                key={`${text}_${String(index)}`}
                className="max-w-full truncate rounded-full border border-accent/30 bg-accent/6 px-2.5 py-0.5 font-mono text-[11px] text-accent"
                title={text}
              >
                {`queued: ${text}`}
              </span>
            ))}
          </div>
        )}
        <div className="flex items-end gap-2 rounded-2xl border border-border bg-surface p-2 shadow-card transition-colors focus-within:border-accent/50">
          <textarea
            ref={textareaRef}
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
            }}
            onKeyDown={onKeyDown}
            placeholder={
              streaming
                ? "Steer the agent — queued for the next turn…"
                : "Send a message…"
            }
            aria-label="Message"
            rows={1}
            className="max-h-50 flex-1 resize-none bg-transparent px-2 py-1.5 text-sm leading-relaxed text-bright outline-none placeholder:text-dim/60 focus-visible:outline-none"
          />
          {streaming && (
            <button
              type="button"
              onClick={onCancel}
              aria-label="Stop generating"
              title="Stop generating"
              className="flex h-10 shrink-0 cursor-pointer items-center gap-1.5 rounded-xl border border-red/30 bg-red/5 px-3.5 text-[13px] font-semibold text-red transition-colors hover:bg-red/10 sm:h-9"
            >
              <svg
                width="10"
                height="10"
                viewBox="0 0 10 10"
                aria-hidden="true"
              >
                <rect width="10" height="10" rx="1.5" fill="currentColor" />
              </svg>
              Stop
            </button>
          )}
          <button
            type="button"
            onClick={send}
            aria-label={streaming ? "Queue steering message" : "Send message"}
            title={streaming ? "Queue a steering message" : "Send message"}
            className="flex h-10 w-10 shrink-0 cursor-pointer items-center justify-center rounded-xl bg-accent text-accent-contrast shadow-xs transition-colors hover:bg-accent-dim disabled:cursor-not-allowed disabled:opacity-40 sm:h-9 sm:w-9"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 14 14"
              fill="none"
              aria-hidden="true"
            >
              <path
                d="M7 12V2M7 2L2.5 6.5M7 2l4.5 4.5"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        </div>
        <p className="mt-1.5 px-2 text-[11px]">
          {blockedHint ? (
            <span className="text-yellow">{blockedHint}</span>
          ) : streaming ? (
            <span className="text-dim/70">
              <span className="hidden sm:inline">
                Enter queues a steering message ·{" "}
                <span className="font-mono text-dim">Shift+Enter</span> for a
                new line
              </span>
              <span className="sm:hidden">Steering — Enter to queue</span>
            </span>
          ) : (
            <span className="text-dim/70">
              <span className="hidden sm:inline">
                Enter to send · Shift+Enter for a new line ·{" "}
              </span>
              Type <span className="font-mono text-dim">/</span> for commands
            </span>
          )}
        </p>
      </div>
    </footer>
  );
}

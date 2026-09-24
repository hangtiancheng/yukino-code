/**
 * Copyright (c) 2026 hangtiancheng
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

import type { SlashCommand } from "@fe/types";
import { useEffect, useMemo, useRef, useState } from "react";

import { SlashMenu } from "./slash-menu";

interface InputAreaProps {
  streaming: boolean;
  commands: SlashCommand[];
  onSend: (text: string) => void;
  onCancel: () => void;
}

const MAX_TEXTAREA_HEIGHT = 200;

export function InputArea({
  streaming,
  commands,
  onSend,
  onCancel,
}: InputAreaProps) {
  const [value, setValue] = useState("");
  const [slashOpen, setSlashOpen] = useState(false);
  const [slashCursor, setSlashCursor] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const filtered = useMemo<SlashCommand[]>(() => {
    if (!value.startsWith("/") || value.includes(" ") || value.includes("\n")) {
      return [];
    }
    const prefix = value.slice(1).toLowerCase();
    return commands.filter((c) => c.name.toLowerCase().startsWith(prefix));
  }, [value, commands]);

  useEffect(() => {
    setSlashOpen(filtered.length > 0);
    setSlashCursor(0);
  }, [filtered]);

  // Auto-grow the textarea up to MAX_TEXTAREA_HEIGHT.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `value` is the trigger — when it changes we re-measure scrollHeight.
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
    if (!text || streaming) {
      return;
    }
    onSend(text);
    setValue("");
    setSlashOpen(false);
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
    <footer className="shrink-0 border-t border-border bg-bg">
      <div className="relative mx-auto w-full max-w-3xl px-5 py-4">
        {slashOpen && (
          <SlashMenu
            commands={filtered}
            cursor={slashCursor}
            onSelect={selectSlash}
            onHover={setSlashCursor}
          />
        )}
        <div className="flex items-end gap-2 rounded-2xl border border-border bg-surface p-2 shadow-card transition-colors focus-within:border-accent/50">
          <textarea
            ref={textareaRef}
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
            }}
            onKeyDown={onKeyDown}
            placeholder="Send a message... (Enter to send, Shift+Enter for newline)"
            aria-label="Message"
            rows={1}
            disabled={streaming}
            className="max-h-50 flex-1 resize-none bg-transparent px-2 py-1.5 text-sm leading-relaxed text-bright outline-none placeholder:text-dim/60 focus-visible:outline-none disabled:opacity-60"
          />
          {streaming ? (
            <button
              type="button"
              onClick={onCancel}
              aria-label="Stop generating"
              title="Stop generating"
              className="flex h-9 shrink-0 cursor-pointer items-center gap-1.5 rounded-xl border border-red/30 bg-red/5 px-3.5 text-[13px] font-semibold text-red transition-colors hover:bg-red/10"
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
          ) : (
            <button
              type="button"
              onClick={send}
              aria-label="Send message"
              className="flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded-xl bg-accent text-white shadow-xs transition-colors hover:bg-accent-dim disabled:cursor-not-allowed disabled:opacity-40"
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
          )}
        </div>
        <p className="mt-1.5 px-2 text-[11px] text-dim/70">
          Type <span className="font-mono text-dim">/</span> for commands
        </p>
      </div>
    </footer>
  );
}

import { useScrollFollow } from "@browser/hooks/use-scroll-follow";
import type {
  FileCompleteResponsePayload,
  ImageResultPayload,
  SlashCommand,
} from "@browser/types";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { SlashMenu } from "./slash-menu";

interface InputAreaProps {
  streaming: boolean;
  commands: SlashCommand[];
  /** Steering messages queued for the in-flight run. */
  steering: string[];
  /** Messages queued as follow-ups while the turn is busy. */
  followUps: string[];
  /** Prompt history shared with the terminal (↑/↓ navigation). */
  history: string[];
  /** Latest @-mention completion response from the server. */
  fileMatches: FileCompleteResponsePayload | null;
  /** Settled image uploads (path inserted as an @-ref, or an error hint). */
  imageResults: ImageResultPayload[];
  onSend: (text: string) => void;
  onCancel: () => void;
  onRequestFileCompletions: (requestId: string, query: string) => void;
  onUploadImage: (clientId: string, name: string, dataBase64: string) => void;
  onConsumeImageResult: (clientId: string) => void;
  onBackgroundShells: () => void;
}

const MAX_TEXTAREA_HEIGHT = 200;
const FILE_COMPLETE_DEBOUNCE_MS = 150;

let uploadCounter = 0;
function nextUploadId(): string {
  uploadCounter += 1;
  return `img_${Date.now().toString(36)}_${String(uploadCounter)}`;
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      resolve(result.slice(result.indexOf(",") + 1));
    };
    reader.onerror = () => {
      reject(reader.error ?? new Error("Failed to read the file."));
    };
    reader.readAsDataURL(file);
  });
}

/** The `@token` immediately before the caret, or null (terminal atQuery parity). */
function atQueryBefore(value: string, caret: number): string | null {
  if (value.startsWith("/") || value.trimStart().startsWith("!")) {
    return null;
  }
  const before = value.slice(0, caret);
  const match = /(?:^|\s)@([^\s]*)$/u.exec(before);
  return match ? match[1] : null;
}

export function InputArea({
  streaming,
  commands,
  steering,
  followUps,
  history,
  fileMatches,
  imageResults,
  onSend,
  onCancel,
  onRequestFileCompletions,
  onUploadImage,
  onConsumeImageResult,
  onBackgroundShells,
}: InputAreaProps) {
  const [value, setValue] = useState("");
  const [caret, setCaret] = useState(0);
  const [slashOpen, setSlashOpen] = useState(false);
  const [slashCursor, setSlashCursor] = useState(0);
  const [blockedHint, setBlockedHint] = useState("");
  const [atCursor, setAtCursor] = useState(0);
  const [atDismissed, setAtDismissed] = useState(false);
  const [uploads, setUploads] = useState<{ clientId: string; name: string }[]>(
    [],
  );
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const blockedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const historyIndexRef = useRef(-1);
  const historyDraftRef = useRef<string | null>(null);
  const atRequestRef = useRef("");
  const { listRef: atListRef, setItemRef: setAtItemRef } =
    useScrollFollow(atCursor);

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

  // ---- @-mention completion ----
  const atQuery = useMemo(() => {
    if (slashOpen) {
      return null;
    }
    return atQueryBefore(value, caret);
  }, [value, caret, slashOpen]);

  useEffect(() => {
    if (atQuery === null) {
      return;
    }
    const requestId = `at_${Date.now().toString(36)}_${String(Math.random()).slice(2, 8)}`;
    const timer = setTimeout(() => {
      atRequestRef.current = requestId;
      onRequestFileCompletions(requestId, atQuery);
    }, FILE_COMPLETE_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [atQuery, onRequestFileCompletions]);

  const atMatches =
    atQuery !== null &&
    !atDismissed &&
    fileMatches !== null &&
    fileMatches.requestId === atRequestRef.current
      ? fileMatches.matches
      : [];

  useEffect(() => {
    setAtCursor(0);
  }, [atMatches.length, atQuery]);

  const applyAtMatch = useCallback(
    (match: string) => {
      const el = textareaRef.current;
      const currentCaret = el?.selectionStart ?? value.length;
      const query = atQueryBefore(value, currentCaret);
      if (query === null) {
        return;
      }
      const tokenStart = currentCaret - query.length - 1;
      const insertion = match.includes(" ") ? `'@${match}'` : `@${match}`;
      const next =
        value.slice(0, tokenStart) + insertion + value.slice(currentCaret);
      setValue(next);
      setAtDismissed(true);
      requestAnimationFrame(() => {
        if (el) {
          const position = tokenStart + insertion.length;
          el.focus();
          el.setSelectionRange(position, position);
          setCaret(position);
        }
      });
    },
    [value],
  );

  // ---- image uploads ----
  const uploadImage = useCallback(
    (file: File) => {
      const clientId = nextUploadId();
      setUploads((prev) => [...prev, { clientId, name: file.name || "image" }]);
      void fileToBase64(file).then(
        (dataBase64) => {
          onUploadImage(clientId, file.name || "image.png", dataBase64);
        },
        () => {
          setUploads((prev) =>
            prev.filter((entry) => entry.clientId !== clientId),
          );
          flashHint("Could not read the image file.");
        },
      );
    },
    [onUploadImage],
  );

  useEffect(() => {
    for (const result of imageResults) {
      setUploads((prev) =>
        prev.filter((entry) => entry.clientId !== result.clientId),
      );
      if (result.path) {
        const insertion = `@'${result.path}'`;
        setValue((current) => {
          const pad = current.length > 0 && !/\s$/u.test(current) ? " " : "";
          return current + pad + insertion + " ";
        });
      } else {
        flashHint(result.message ?? "Image upload failed.");
      }
      onConsumeImageResult(result.clientId);
    }
  }, [imageResults, onConsumeImageResult]);

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

  function flashHint(message: string): void {
    setBlockedHint(message);
    if (blockedTimerRef.current) {
      clearTimeout(blockedTimerRef.current);
    }
    blockedTimerRef.current = setTimeout(() => {
      setBlockedHint("");
    }, 4000);
  }

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
    onSend(text);
    setValue("");
    setSlashOpen(false);
    setAtDismissed(false);
    setBlockedHint("");
    historyIndexRef.current = -1;
    historyDraftRef.current = null;
  };

  /** ↑/↓ prompt-history navigation when the caret is at a vertical edge. */
  const navigateHistory = (direction: -1 | 1): boolean => {
    if (history.length === 0) {
      return false;
    }
    const index = historyIndexRef.current;
    if (direction === -1) {
      const next = index === -1 ? history.length - 1 : Math.max(0, index - 1);
      if (index === -1) {
        historyDraftRef.current = value;
      }
      historyIndexRef.current = next;
      const entry = history[next];
      if (entry !== undefined) {
        setValue(entry);
      }
      return true;
    }
    if (index === -1) {
      return false;
    }
    const next = index + 1;
    if (next >= history.length) {
      historyIndexRef.current = -1;
      setValue(historyDraftRef.current ?? "");
      historyDraftRef.current = null;
      return true;
    }
    historyIndexRef.current = next;
    const entry = history[next];
    if (entry !== undefined) {
      setValue(entry);
    }
    return true;
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // While an IME composition is active, Enter/arrows/Escape belong to the
    // composition window — never send or navigate mid-composition.
    if (e.nativeEvent.isComposing) {
      return;
    }
    setCaret(e.currentTarget.selectionStart ?? value.length);

    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "b") {
      e.preventDefault();
      onBackgroundShells();
      return;
    }

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
      if ((e.key === "Tab" || e.key === "Enter") && !e.shiftKey) {
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

    if (atMatches.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setAtCursor((c) => Math.min(c + 1, atMatches.length - 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setAtCursor((c) => Math.max(c - 1, 0));
        return;
      }
      if ((e.key === "Tab" || e.key === "Enter") && !e.shiftKey) {
        e.preventDefault();
        const match = atMatches[atCursor];
        if (match) {
          applyAtMatch(match);
        }
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setAtDismissed(true);
        return;
      }
    }

    if (e.key === "Escape") {
      e.preventDefault();
      if (streaming) {
        onCancel();
      } else if (value) {
        setValue("");
      }
      return;
    }

    if (e.key === "ArrowUp" && !e.shiftKey) {
      const el = e.currentTarget;
      const currentCaret = el.selectionStart ?? 0;
      const onFirstLine = !value.slice(0, currentCaret).includes("\n");
      if (onFirstLine && navigateHistory(-1)) {
        e.preventDefault();
        return;
      }
    }
    if (e.key === "ArrowDown" && !e.shiftKey) {
      const el = e.currentTarget;
      const currentCaret = el.selectionStart ?? 0;
      const onLastLine = !value.slice(currentCaret).includes("\n");
      if (onLastLine && historyIndexRef.current !== -1 && navigateHistory(1)) {
        e.preventDefault();
        return;
      }
    }

    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  const trimmed = value.trimStart();
  const bashMode = trimmed.startsWith("!");
  const bashExcluded = trimmed.startsWith("!!");

  return (
    <footer className="shrink-0 border-t border-border bg-bg [padding-bottom:env(safe-area-inset-bottom)]">
      <div className="relative mx-auto w-full max-w-5xl px-4 py-3 sm:px-6 sm:py-4">
        {slashOpen && (
          <SlashMenu
            commands={filtered}
            cursor={slashCursor}
            onSelect={selectSlash}
            onHover={setSlashCursor}
          />
        )}
        {atMatches.length > 0 && (
          <div
            ref={atListRef}
            role="listbox"
            aria-label="File completions"
            className="absolute inset-x-4 bottom-full mb-2 max-h-64 overflow-y-auto rounded-xl border border-border bg-surface py-1 shadow-pop sm:inset-x-6"
          >
            {atMatches.map((match, i) => (
              <button
                key={match}
                ref={setAtItemRef(i)}
                type="button"
                role="option"
                aria-selected={i === atCursor}
                onMouseDown={(e) => {
                  e.preventDefault();
                  applyAtMatch(match);
                }}
                onMouseEnter={() => {
                  setAtCursor(i);
                }}
                className={`flex w-full cursor-pointer items-center gap-2.5 px-3.5 py-1.5 text-left transition-colors ${i === atCursor ? "bg-accent/8" : ""}`}
              >
                <span className="truncate font-mono text-xs text-base">
                  {match}
                </span>
              </button>
            ))}
          </div>
        )}
        {(steering.length > 0 || followUps.length > 0) && (
          <div
            className="mb-2 flex flex-wrap gap-1.5"
            role="status"
            aria-label="Queued messages"
          >
            {steering.map((text, index) => (
              <span
                key={`steer_${text}_${String(index)}`}
                className="max-w-full truncate rounded-full border border-accent/30 bg-accent/6 px-2.5 py-0.5 font-mono text-[11px] text-accent"
                title={text}
              >
                {`steering: ${text}`}
              </span>
            ))}
            {followUps.map((text, index) => (
              <span
                key={`follow_${text}_${String(index)}`}
                className="max-w-full truncate rounded-full border border-yellow/30 bg-yellow/6 px-2.5 py-0.5 font-mono text-[11px] text-yellow"
                title={text}
              >
                {`follow-up: ${text}`}
              </span>
            ))}
          </div>
        )}
        {blockedHint && (
          <p className="mb-2 font-mono text-[11px] text-yellow" role="alert">
            {blockedHint}
          </p>
        )}
        {/* Composer card: textarea on top, action toolbar below — attach and
            send share one baseline instead of floating beside the textarea. */}
        <div
          className={`rounded-2xl border bg-surface shadow-card transition-colors focus-within:border-accent/60 ${
            streaming ? "border-accent/35" : "border-border"
          }`}
        >
          {uploads.length > 0 && (
            <div
              className="flex flex-wrap gap-1.5 px-3 pt-3"
              aria-label="Uploading images"
            >
              {uploads.map((upload) => (
                <span
                  key={upload.clientId}
                  className="flex max-w-full items-center gap-1.5 truncate rounded-full border border-border bg-tool px-2.5 py-0.5 font-mono text-[11px] text-dim"
                  title={upload.name}
                >
                  <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-accent" />
                  <span className="truncate">{upload.name}</span>
                </span>
              ))}
            </div>
          )}
          <textarea
            ref={textareaRef}
            rows={1}
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              setCaret(e.target.selectionStart ?? 0);
              setAtDismissed(false);
            }}
            onKeyDown={onKeyDown}
            onKeyUp={(e) => {
              setCaret(e.currentTarget.selectionStart ?? 0);
            }}
            onClick={(e) => {
              setCaret(e.currentTarget.selectionStart ?? 0);
            }}
            onSelect={(e) => {
              setCaret(e.currentTarget.selectionStart ?? 0);
            }}
            onPaste={(e) => {
              const files = Array.from(e.clipboardData?.files ?? []).filter(
                (file) => file.type.startsWith("image/"),
              );
              if (files.length > 0) {
                e.preventDefault();
                for (const file of files) {
                  uploadImage(file);
                }
              }
            }}
            onDrop={(e) => {
              const files = Array.from(e.dataTransfer?.files ?? []).filter(
                (file) => file.type.startsWith("image/"),
              );
              if (files.length > 0) {
                e.preventDefault();
                for (const file of files) {
                  uploadImage(file);
                }
              }
            }}
            onDragOver={(e) => {
              e.preventDefault();
            }}
            placeholder={
              streaming
                ? "Send a steering message… (Enter)"
                : "Message Yukino… (Enter to send, Shift+Enter for a new line, ! for Bash)"
            }
            className="block max-h-50 w-full resize-none bg-transparent px-4 pt-3.5 pb-1.5 text-sm leading-relaxed text-bright outline-none placeholder:text-dim/70"
            aria-label="Message input"
          />
          <div className="flex items-center gap-2 px-2.5 pb-2.5">
            <input
              ref={fileInputRef}
              type="file"
              accept="image/png,image/jpeg,image/gif,image/webp"
              multiple
              className="hidden"
              onChange={(e) => {
                for (const file of Array.from(e.target.files ?? [])) {
                  uploadImage(file);
                }
                e.target.value = "";
              }}
            />
            <button
              type="button"
              aria-label="Attach images"
              title="Attach images (or paste/drop them)"
              onClick={() => {
                fileInputRef.current?.click();
              }}
              className="flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-lg border border-border text-dim transition-colors hover:bg-tool hover:text-bright"
            >
              <svg
                width="15"
                height="15"
                viewBox="0 0 16 16"
                fill="none"
                aria-hidden="true"
              >
                <rect
                  x="1.8"
                  y="3"
                  width="12.4"
                  height="10"
                  rx="1.7"
                  stroke="currentColor"
                  strokeWidth="1.2"
                />
                <circle cx="5.6" cy="6.6" r="1.1" fill="currentColor" />
                <path
                  d="m2.6 11.6 3.2-3 2.4 2.2 2.3-2.6 2.9 3.4"
                  stroke="currentColor"
                  strokeWidth="1.2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
            {bashMode && (
              <span className="shrink-0 rounded-md border border-yellow/40 bg-yellow/10 px-2 py-0.5 font-mono text-[10px] font-semibold text-yellow">
                {bashExcluded ? "Bash · excluded" : "Bash"}
              </span>
            )}
            <div className="min-w-0 flex-1" />
            {streaming ? (
              <button
                type="button"
                onClick={onCancel}
                title="Cancel the running turn (Esc)"
                className="flex h-8 shrink-0 cursor-pointer items-center gap-1.5 rounded-lg border border-red/40 bg-red/10 px-2.5 font-mono text-xs font-semibold text-red transition-colors hover:bg-red/15"
              >
                <svg
                  width="10"
                  height="10"
                  viewBox="0 0 10 10"
                  fill="currentColor"
                  aria-hidden="true"
                >
                  <rect x="1.5" y="1.5" width="7" height="7" rx="1" />
                </svg>
                Cancel
              </button>
            ) : (
              <button
                type="button"
                onClick={send}
                disabled={value.trim().length === 0}
                className="flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-lg bg-accent text-accent-contrast transition-opacity disabled:cursor-default disabled:opacity-30"
                aria-label="Send message"
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 16 16"
                  fill="none"
                  aria-hidden="true"
                >
                  <path
                    d="M8 13.5V3m0 0L3.8 7.2M8 3l4.2 4.2"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
            )}
          </div>
        </div>
        <p className="mt-2 hidden text-center text-[10px] text-dim/70 sm:block">
          Enter send · Shift+Enter newline · ↑ history · @ files · ! bash ·
          paste/drop images · Esc cancel
        </p>
      </div>
    </footer>
  );
}

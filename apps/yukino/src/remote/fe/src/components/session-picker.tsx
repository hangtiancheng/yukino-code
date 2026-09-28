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

import type { SessionSummary } from "@fe/types";

import { Modal, ModalHeader } from "./modal";

interface SessionPickerProps {
  sessions: SessionSummary[];
  onPick: (id: string) => void;
  onClose: () => void;
}

function relativeTime(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) {
    return "";
  }
  const diffMs = Date.now() - then;
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) {
    return "just now";
  }
  if (minutes < 60) {
    return `${String(minutes)}m ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${String(hours)}h ago`;
  }
  const days = Math.floor(hours / 24);
  if (days < 30) {
    return `${String(days)}d ago`;
  }
  return new Date(then).toLocaleDateString();
}

/** Session list for /resume; picking a row resumes that session. */
export function SessionPicker({
  sessions,
  onPick,
  onClose,
}: SessionPickerProps) {
  return (
    <Modal label="Resume a session" onEscape={onClose}>
      <ModalHeader
        subtitle="Pick a session to replace the current conversation."
        title="Resume a session"
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {sessions.map((sess) => (
          <button
            key={sess.id}
            type="button"
            onClick={() => {
              onPick(sess.id);
            }}
            className="flex w-full cursor-pointer items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors hover:bg-bg"
          >
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm text-bright">
                {sess.firstMessage || "(no messages)"}
              </span>
              <span className="mt-0.5 block truncate font-mono text-[11px] text-dim">
                {sess.id}
              </span>
            </span>
            <span className="shrink-0 text-right font-mono text-[11px] text-dim tabular-nums">
              <span className="block">{`${String(sess.messageCount)} msgs`}</span>
              <span className="mt-0.5 block">{relativeTime(sess.modTime)}</span>
            </span>
          </button>
        ))}
      </div>
      <div className="flex items-center justify-between border-t border-border px-5 py-3">
        <p className="text-[11px] text-dim/70">
          Or type <span className="font-mono text-dim">/resume &lt;id&gt;</span>
        </p>
        <button
          type="button"
          onClick={onClose}
          className="cursor-pointer rounded-lg border border-border px-3.5 py-1.5 text-[13px] font-semibold text-base transition-colors hover:bg-bg"
        >
          Cancel
        </button>
      </div>
    </Modal>
  );
}

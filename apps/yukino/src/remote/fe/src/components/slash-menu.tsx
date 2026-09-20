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

interface SlashMenuProps {
  commands: SlashCommand[];
  cursor: number;
  onSelect: (index: number) => void;
  onHover: (index: number) => void;
}

export function SlashMenu({ commands, cursor, onSelect, onHover }: SlashMenuProps) {
  if (commands.length === 0) {
    return null;
  }
  return (
    <div
      role="listbox"
      aria-label="Slash commands"
      className="absolute inset-x-5 bottom-full mb-2 max-h-64 overflow-y-auto rounded-xl border border-border bg-surface py-1 shadow-pop"
    >
      {commands.map((cmd, i) => (
        <button
          key={cmd.name}
          type="button"
          role="option"
          aria-selected={i === cursor}
          onMouseDown={(e) => {
            e.preventDefault();
            onSelect(i);
          }}
          onMouseEnter={() => {
            onHover(i);
          }}
          className={`flex w-full cursor-pointer items-baseline gap-2.5 px-3.5 py-2 text-left ${
            i === cursor ? "bg-accent/8" : ""
          }`}
        >
          <span className="font-mono text-[13px] font-semibold whitespace-nowrap text-accent">
            /{cmd.name}
          </span>
          <span className="overflow-hidden text-ellipsis whitespace-nowrap text-xs text-dim">
            {cmd.description}
          </span>
        </button>
      ))}
    </div>
  );
}

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

import type { PermissionItem, PermissionResponse } from "@fe/types";

interface PermissionDialogProps {
  item: PermissionItem;
  onRespond: (id: string, response: PermissionResponse) => void;
}

const RESPONSE_OPTIONS: {
  value: PermissionResponse;
  label: string;
  className: string;
}[] = [
  {
    value: "allow",
    label: "Allow",
    className: "bg-accent text-white shadow-xs hover:bg-accent-dim",
  },
  {
    value: "allowAlways",
    label: "Allow Always",
    className: "border border-accent/40 text-accent hover:bg-accent/8",
  },
  { value: "deny", label: "Deny", className: "border border-red/30 text-red hover:bg-red/6" },
];

export function PermissionDialog({ item, onRespond }: PermissionDialogProps) {
  return (
    <section
      aria-label={`Permission required for ${item.toolName}`}
      className="my-3 rounded-xl border border-yellow/35 bg-surface p-4 shadow-xs"
    >
      <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-yellow">
        <svg width="13" height="13" viewBox="0 0 13 13" fill="none" aria-hidden="true">
          <rect
            x="2"
            y="5.5"
            width="9"
            height="6"
            rx="1.2"
            stroke="currentColor"
            strokeWidth="1.4"
          />
          <path d="M4 5.5V4a2.5 2.5 0 015 0v1.5" stroke="currentColor" strokeWidth="1.4" />
        </svg>
        Permission Required: <span className="font-mono">{item.toolName}</span>
      </div>
      <div className="mb-3 font-mono text-xs leading-relaxed whitespace-pre-wrap text-base">
        {item.description}
      </div>
      {item.responded ? (
        <div className="text-xs text-dim">
          <span className="mr-1 text-green">✓</span> Permission: {item.response}
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          {RESPONSE_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={() => {
                onRespond(item.id, opt.value);
              }}
              className={`cursor-pointer rounded-lg px-4 py-1.5 text-[13px] font-semibold transition-colors ${opt.className}`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

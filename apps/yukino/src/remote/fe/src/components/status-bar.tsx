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

interface StatusBarProps {
  connection: "connecting" | "connected" | "reconnecting";
  usage: { inputTokens: number; outputTokens: number } | null;
  cwd: string;
}

const CONNECTION_LABEL: Record<StatusBarProps["connection"], string> = {
  connecting: "Connecting...",
  connected: "Connected",
  reconnecting: "Reconnecting...",
};

const DOT_COLOR: Record<StatusBarProps["connection"], string> = {
  connecting: "bg-yellow",
  connected: "bg-green",
  reconnecting: "bg-red",
};

export function StatusBar({ connection, usage, cwd }: StatusBarProps) {
  const usageText = usage
    ? `In: ${formatTokensLocal(usage.inputTokens)} | Out: ${formatTokensLocal(usage.outputTokens)}`
    : "";

  return (
    <header className="shrink-0 border-b border-border bg-surface/80 backdrop-blur">
      <div className="mx-auto flex w-full max-w-3xl items-center justify-between px-5 py-2.5">
        <div className="flex items-center gap-2">
          <span className="flex h-6 w-6 items-center justify-center rounded-md bg-accent text-xs font-bold text-white">
            S
          </span>
          <span className="text-sm font-semibold text-bright">
            Yukino Remote
          </span>
        </div>
        <div className="flex items-center gap-4 text-xs text-dim">
          {cwd && (
            <span
              className="hidden max-w-64 truncate font-mono text-[11px] sm:inline"
              title={cwd}
            >
              {cwd}
            </span>
          )}
          {usageText && (
            <span className="font-mono tabular-nums">{usageText}</span>
          )}
          <span className="flex items-center" role="status">
            <span
              className={`mr-1.5 inline-block h-2 w-2 rounded-full ${DOT_COLOR[connection]}`}
            />
            {CONNECTION_LABEL[connection]}
          </span>
        </div>
      </div>
    </header>
  );
}

function formatTokensLocal(n: number): string {
  if (n > 1_000_000) {
    return `${(n / 1_000_000).toFixed(1)}M`;
  }
  if (n > 1000) {
    return `${(n / 1000).toFixed(1)}K`;
  }
  return String(n);
}

import type { Theme } from "@browser/hooks/use-theme";
import { formatTokens } from "@browser/lib/format";

interface StatusBarProps {
  connection: "connecting" | "connected" | "reconnecting";
  usage: { inputTokens: number; outputTokens: number } | null;
  cwd: string;
  model: string;
  permissionMode: string;
  thinkingLevel: string;
  theme: Theme;
  onToggleTheme: () => void;
}

const CONNECTION_LABEL: Record<StatusBarProps["connection"], string> = {
  connecting: "Connecting",
  connected: "Connected",
  reconnecting: "Reconnecting",
};

const DOT_COLOR: Record<StatusBarProps["connection"], string> = {
  connecting: "bg-yellow",
  connected: "bg-green",
  reconnecting: "bg-red",
};

/** Badge styling per permission mode; "default" shows no badge. Colors mirror
 *  the TUI footer: plan = warning, acceptEdits = success, bypass = error. */
const MODE_BADGE: Record<string, string> = {
  plan: "bg-yellow/15 text-yellow",
  bypassPermissions: "bg-red/15 text-red",
  acceptEdits: "bg-green/15 text-green",
};

const MODE_LABEL: Record<string, string> = {
  plan: "Plan",
  bypassPermissions: "YOLO",
  acceptEdits: "Accept Edits",
};

export function StatusBar({
  connection,
  usage,
  cwd,
  model,
  permissionMode,
  thinkingLevel,
  theme,
  onToggleTheme,
}: StatusBarProps) {
  const usageText = usage
    ? `↑${formatTokens(usage.inputTokens)} ↓${formatTokens(usage.outputTokens)}`
    : "";
  const modeBadge = MODE_BADGE[permissionMode];
  const isDark = theme === "dark";

  return (
    <header className="shrink-0 border-b border-border bg-surface/85 backdrop-blur [padding-top:env(safe-area-inset-top)]">
      <div className="mx-auto flex w-full max-w-3xl items-center justify-between gap-2 px-3 py-2 sm:gap-3 sm:px-5 sm:py-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <span
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-accent/15 text-accent"
            aria-hidden="true"
          >
            {/* Snowflake mark — a nod to Yukino (雪). */}
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
              <path
                d="M8 1v14M8 1 6 3m2-2 2 2M8 15l-2-2m2 2 2-2M2 4.5l12 7M2 4.5l.4 2.7m-.4-2.7 2.6.7M14 11.5l-.4-2.7m.4 2.7-2.6-.7M14 4.5l-12 7M14 4.5l-2.6.7m2.6-.7-.4 2.7M2 11.5l.4-2.7m-.4 2.7 2.6-.7"
                stroke="currentColor"
                strokeWidth="1.2"
                strokeLinecap="round"
              />
            </svg>
          </span>
          <span className="shrink-0 text-sm font-semibold text-bright">
            Yukino
          </span>
          <span className="hidden shrink-0 text-sm text-dim xs:inline">
            Remote
          </span>
          {modeBadge && (
            <span
              className={`shrink-0 rounded-full px-2 py-0.5 font-mono text-[10px] font-semibold tracking-wide ${modeBadge}`}
              title={`Permission mode: ${permissionMode}`}
            >
              {MODE_LABEL[permissionMode] ?? permissionMode}
            </span>
          )}
          {model && (
            <span
              className="hidden max-w-40 truncate font-mono text-[11px] text-dim md:inline"
              title={model}
            >
              {model}
            </span>
          )}
          {thinkingLevel && (
            <span
              className="hidden rounded-full border border-border px-2 py-0.5 font-mono text-[10px] text-dim lg:inline"
              title={`Thinking level: ${thinkingLevel}`}
            >
              think: {thinkingLevel}
            </span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2 text-xs text-dim sm:gap-4">
          {cwd && (
            <span
              className="hidden max-w-56 truncate font-mono text-[11px] xl:inline"
              title={cwd}
            >
              {cwd}
            </span>
          )}
          {usageText && (
            <span className="hidden font-mono tabular-nums sm:inline">
              {usageText}
            </span>
          )}
          <span
            className="flex items-center gap-1.5"
            role="status"
            title={CONNECTION_LABEL[connection]}
          >
            <span
              className={`inline-block h-2 w-2 shrink-0 rounded-full ${DOT_COLOR[connection]} ${connection === "connected" ? "" : "animate-pulse"}`}
            />
            <span className="hidden sm:inline">
              {CONNECTION_LABEL[connection]}
            </span>
          </span>
          <button
            type="button"
            onClick={onToggleTheme}
            aria-label={
              isDark ? "Switch to light theme" : "Switch to dark theme"
            }
            title={isDark ? "Light theme" : "Dark theme"}
            className="flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-lg border border-border text-dim transition-colors hover:bg-tool hover:text-bright"
          >
            {isDark ? (
              <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
                <circle
                  cx="8"
                  cy="8"
                  r="3.2"
                  stroke="currentColor"
                  strokeWidth="1.3"
                />
                <path
                  d="M8 .8v1.8M8 13.4v1.8M.8 8h1.8M13.4 8h1.8M3 3l1.3 1.3M11.7 11.7 13 13M13 3l-1.3 1.3M4.3 11.7 3 13"
                  stroke="currentColor"
                  strokeWidth="1.3"
                  strokeLinecap="round"
                />
              </svg>
            ) : (
              <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
                <path
                  d="M13.5 9.5A5.8 5.8 0 0 1 6.5 2.5a5.8 5.8 0 1 0 7 7Z"
                  stroke="currentColor"
                  strokeWidth="1.3"
                  strokeLinejoin="round"
                />
              </svg>
            )}
          </button>
        </div>
      </div>
    </header>
  );
}

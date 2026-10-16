import { formatTokens } from "@browser/lib/format";
import type { ConnectionStatus, UsagePayload } from "@browser/types";

interface StatusBarProps {
  connection: ConnectionStatus;
  usage: UsagePayload | null;
  cwd: string;
  session: string;
  model: string;
  provider: string;
  permissionMode: string;
  thinkingLevel: string;
  sandboxEnabled: boolean;
  sandboxAutoAllow: boolean;
  theme: "dark" | "light";
  /** Running subagents + background tasks + teammates (opens the Agents panel). */
  agentCount: number;
  onToggleTheme: () => void;
  onCycleMode: () => void;
  onOpenModelPicker: () => void;
  onOpenThinkingPicker: () => void;
  onOpenActivity: () => void;
}

const CONNECTION_LABEL: Record<ConnectionStatus, string> = {
  connecting: "Connecting",
  connected: "Connected",
  reconnecting: "Reconnecting",
};

const DOT_COLOR: Record<ConnectionStatus, string> = {
  connecting: "bg-yellow",
  connected: "bg-green",
  reconnecting: "bg-red",
};

const MODE_BADGE: Record<string, string> = {
  default: "border-border bg-tool text-dim",
  plan: "border-yellow/40 bg-yellow/15 text-yellow",
  bypassPermissions: "border-red/40 bg-red/15 text-red",
  acceptEdits: "border-green/40 bg-green/15 text-green",
};

const MODE_LABEL: Record<string, string> = {
  default: "Default",
  plan: "Plan",
  bypassPermissions: "YOLO",
  acceptEdits: "Accept Edits",
};

export function StatusBar({
  connection,
  usage,
  cwd,
  session,
  model,
  provider,
  permissionMode,
  thinkingLevel,
  sandboxEnabled,
  sandboxAutoAllow,
  theme,
  agentCount,
  onToggleTheme,
  onCycleMode,
  onOpenModelPicker,
  onOpenThinkingPicker,
  onOpenActivity,
}: StatusBarProps) {
  const isDark = theme === "dark";
  const modeBadge = MODE_BADGE[permissionMode] ?? MODE_BADGE.default;
  const contextWindow = usage?.contextWindow ?? 0;
  const contextTokens = usage?.contextTokens ?? 0;
  const percentage =
    contextWindow > 0 ? (contextTokens / contextWindow) * 100 : 0;
  const contextColor =
    percentage >= 90
      ? "text-red"
      : percentage >= 70
        ? "text-yellow"
        : "text-dim";
  const usageText = usage
    ? `↑${formatTokens(usage.inputTokens)} ↓${formatTokens(usage.outputTokens)}`
    : "";

  return (
    <header className="shrink-0 border-b border-border bg-surface/85 backdrop-blur [padding-top:env(safe-area-inset-top)]">
      <div className="mx-auto flex w-full max-w-5xl items-center justify-between gap-2 px-4 py-2 sm:gap-3 sm:px-6 sm:py-2.5">
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
          <button
            type="button"
            onClick={onCycleMode}
            title="Permission mode — click or Shift+Tab to cycle"
            className={`shrink-0 cursor-pointer rounded-full border px-2 py-0.5 font-mono text-[10px] font-semibold tracking-wide transition-opacity hover:opacity-80 ${modeBadge}`}
          >
            {permissionMode
              ? (MODE_LABEL[permissionMode] ?? permissionMode)
              : "Default"}
          </button>
          {model && (
            <button
              type="button"
              onClick={onOpenModelPicker}
              title={`${provider ? `${provider} · ` : ""}${model} — click to switch model`}
              className="hidden max-w-40 cursor-pointer truncate font-mono text-[11px] text-dim transition-colors hover:text-bright md:inline"
            >
              {provider ? `${provider}/` : ""}
              {model}
            </button>
          )}
          {thinkingLevel && (
            <button
              type="button"
              onClick={onOpenThinkingPicker}
              title={`Thinking level: ${thinkingLevel} — click to change`}
              className="hidden cursor-pointer rounded-full border border-border px-2 py-0.5 font-mono text-[10px] text-dim transition-colors hover:text-bright lg:inline"
            >
              think: {thinkingLevel}
            </button>
          )}
          {sandboxEnabled && (
            <span
              className="hidden shrink-0 rounded-full border border-green/40 bg-green/10 px-2 py-0.5 font-mono text-[10px] text-green sm:inline"
              title={`Sandbox: ON (${sandboxAutoAllow ? "auto-allow" : "manual permissions"})`}
            >
              sandbox
            </span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2 text-xs text-dim sm:gap-3">
          {agentCount > 0 && (
            <button
              type="button"
              onClick={onOpenActivity}
              title="View subagents, background tasks and teammates"
              className="flex cursor-pointer items-center gap-1 rounded-full border border-accent/40 bg-accent/10 px-2 py-0.5 font-mono text-[10px] font-semibold text-accent transition-opacity hover:opacity-80"
            >
              <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
              {String(agentCount)}
            </button>
          )}
          {cwd && (
            <span
              className="hidden max-w-44 truncate font-mono text-[11px] text-dim xl:inline"
              title={`${cwd}${session ? ` · session ${session}` : ""}`}
            >
              {cwd}
            </span>
          )}
          {usageText && (
            <span className="hidden font-mono tabular-nums sm:inline">
              {usageText}
            </span>
          )}
          {contextWindow > 0 && (
            <span
              className={`hidden font-mono tabular-nums sm:inline ${contextColor}`}
              title="Context window occupancy"
            >
              {`${percentage.toFixed(1)}%/${formatTokens(contextWindow)}`}
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

import { MODE_LABEL } from "#/constants.js";
import { formatTokens } from "#/lib/format.js";
import type { ConnectionStatus, UsagePayload } from "#/types.js";

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
  agentCount: number;
  onToggleTheme: () => void;
  onCycleMode: () => void;
  onOpenModelPicker: () => void;
  onOpenThinkingPicker: () => void;
  onOpenActivity: () => void;
}

export function StatusBar(props: StatusBarProps) {
  const { usage, connection } = props;
  const contextWindow = usage?.contextWindow ?? 0;
  const percentage =
    contextWindow > 0 ? ((usage?.contextTokens ?? 0) / contextWindow) * 100 : 0;
  const modeColor =
    props.permissionMode === "plan"
      ? "text-warning"
      : props.permissionMode === "bypassPermissions"
        ? "text-error"
        : props.permissionMode === "acceptEdits"
          ? "text-success"
          : "";
  const connectionColor =
    connection === "connected"
      ? "text-success"
      : connection === "connecting"
        ? "text-warning"
        : "text-error";
  return (
    <footer className="status-bar mx-auto w-full max-w-[68rem] shrink-0 px-3 pt-2 pb-3 font-mono text-[11px] text-muted sm:px-8 sm:pb-4">
      <div className="flex min-w-0 items-center gap-3">
        <span className="min-w-0 flex-1 truncate" title={props.cwd}>
          {props.cwd || "Yukino"}
          {props.session && (
            <span className="text-dim"> · {props.session}</span>
          )}
        </span>
        <span className={connectionColor} role="status" title={connection}>
          <span aria-hidden="true">
            {connection === "connected" ? "●" : "◌"}
          </span>
          <span className="ml-1 hidden sm:inline">{connection}</span>
        </span>
        <button
          type="button"
          onClick={props.onToggleTheme}
          className="cursor-pointer text-dim hover:text-accent"
          aria-label={`Switch to ${props.theme === "dark" ? "light" : "dark"} theme`}
        >
          {props.theme}
        </button>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 tabular-nums">
        {usage && (
          <span>
            ↑{formatTokens(usage.inputTokens)} ↓
            {formatTokens(usage.outputTokens)}
          </span>
        )}
        {contextWindow > 0 && (
          <span
            className={
              percentage >= 90
                ? "text-error"
                : percentage >= 70
                  ? "text-warning"
                  : ""
            }
          >
            {percentage.toFixed(1)}%/{formatTokens(contextWindow)}
          </span>
        )}
        <div className="min-w-0 flex-1" />
        {props.model && (
          <button
            type="button"
            onClick={props.onOpenModelPicker}
            title={`${props.provider}/${props.model} — switch model`}
            className="max-w-full cursor-pointer truncate hover:text-accent"
          >
            <span className="hidden lg:inline">({props.provider}) </span>
            {props.model}
          </button>
        )}
        {props.thinkingLevel && (
          <button
            type="button"
            onClick={props.onOpenThinkingPicker}
            className="cursor-pointer hover:text-accent"
            title="Change thinking level"
          >
            {props.thinkingLevel}
          </button>
        )}
        <button
          type="button"
          onClick={props.onCycleMode}
          title="Shift+Tab to cycle permission mode"
          className={`cursor-pointer hover:underline ${modeColor}`}
        >
          {MODE_LABEL[props.permissionMode] ?? props.permissionMode}
        </button>
        {props.sandboxEnabled && (
          <span
            className="text-success"
            title={`Sandbox: ${props.sandboxAutoAllow ? "auto-allow" : "manual permissions"}`}
          >
            sandbox
          </span>
        )}
        {props.agentCount > 0 && (
          <button
            type="button"
            onClick={props.onOpenActivity}
            className="cursor-pointer text-accent hover:underline"
          >
            {String(props.agentCount)} agents
          </button>
        )}
      </div>
    </footer>
  );
}

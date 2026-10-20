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

const MODE_LABEL: Record<string, string> = {
  default: "Default",
  plan: "Plan",
  bypassPermissions: "YOLO",
  acceptEdits: "Accept Edits",
};

export function StatusBar(props: StatusBarProps) {
  const { usage, connection } = props;
  const contextWindow = usage?.contextWindow ?? 0;
  const percentage =
    contextWindow > 0 ? ((usage?.contextTokens ?? 0) / contextWindow) * 100 : 0;
  const modeColor =
    props.permissionMode === "plan"
      ? "text-yellow"
      : props.permissionMode === "bypassPermissions"
        ? "text-red"
        : props.permissionMode === "acceptEdits"
          ? "text-green"
          : "";
  const connectionColor =
    connection === "connected"
      ? "text-green"
      : connection === "connecting"
        ? "text-yellow"
        : "text-red";
  return (
    <footer className="shrink-0 px-3 pb-2 text-xs text-muted sm:px-5">
      <div className="flex min-w-0 items-baseline gap-3">
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
      <div className="mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-1 tabular-nums">
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
                ? "text-red"
                : percentage >= 70
                  ? "text-yellow"
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
            className="text-green"
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

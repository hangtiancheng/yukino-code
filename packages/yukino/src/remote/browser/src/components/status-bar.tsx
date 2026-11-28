import { Button } from "#/components/ui/button.js";
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from "#/components/ui/collapsible.js";
import {
  MODE_LABEL,
  REMOTE_AUTH_REQUIRED,
  REMOTE_AUTH_STATUS,
} from "#/constants.js";
import type { ConnectionStatus, RuntimeStatus, UsagePayload } from "#/types.js";
import { formatRuntimeStatus } from "@/runtime/status.js";
import { formatTokens } from "@/utils/format.js";

interface StatusBarProps {
  connection: ConnectionStatus;
  usage: UsagePayload | null;
  runtimeStatus: RuntimeStatus | null;
  onWarmingControl: (action: "stop" | "resume") => void;
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
        <span
          className={connectionColor}
          role="status"
          title={
            connection === "unauthorized" ? REMOTE_AUTH_REQUIRED : connection
          }
        >
          <span aria-hidden="true">
            {connection === "connected" ? "●" : "◌"}
          </span>
          <span className="ml-1 hidden sm:inline">
            {connection === "unauthorized" ? REMOTE_AUTH_STATUS : connection}
          </span>
        </span>
        <Button
          type="button"
          onClick={props.onToggleTheme}
          className="cursor-pointer text-dim hover:text-accent"
          aria-label={`Switch to ${props.theme === "dark" ? "light" : "dark"} theme`}
        >
          {props.theme}
        </Button>
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
          <Button
            type="button"
            onClick={props.onOpenModelPicker}
            title={`${props.provider}/${props.model} — switch model`}
            className="max-w-full cursor-pointer truncate hover:text-accent"
          >
            <span className="hidden lg:inline">({props.provider}) </span>
            {props.model}
          </Button>
        )}
        {props.thinkingLevel && (
          <Button
            type="button"
            onClick={props.onOpenThinkingPicker}
            className="cursor-pointer hover:text-accent"
            title="Change thinking level"
          >
            {props.thinkingLevel}
          </Button>
        )}
        <Button
          type="button"
          onClick={props.onCycleMode}
          title="Shift+Tab to cycle permission mode"
          className={`cursor-pointer hover:underline ${modeColor}`}
        >
          {MODE_LABEL[props.permissionMode] ?? props.permissionMode}
        </Button>
        {props.sandboxEnabled && (
          <span
            className="text-success"
            title={`Sandbox: ${props.sandboxAutoAllow ? "auto-allow" : "manual permissions"}`}
          >
            sandbox
          </span>
        )}
        {props.agentCount > 0 && (
          <Button
            type="button"
            onClick={props.onOpenActivity}
            className="cursor-pointer text-accent hover:underline"
          >
            {String(props.agentCount)} agents
          </Button>
        )}
      </div>
      {props.runtimeStatus && (
        <div className="mt-1 flex items-start gap-3">
          <Collapsible className="min-w-0 flex-1">
            <CollapsibleTrigger className="cursor-pointer hover:text-accent">
              Actual run: {String(props.runtimeStatus.run?.cost.requests ?? 0)}{" "}
              requests
              {" · "}History: {String(props.runtimeStatus.history.length)}{" "}
              sources
              {" · "}Warming: {props.runtimeStatus.cache.warming.state}
            </CollapsibleTrigger>
            <CollapsibleContent>
              <pre className="mt-2 overflow-x-auto whitespace-pre-wrap rounded border border-muted p-2">
                {formatRuntimeStatus(props.runtimeStatus)}
              </pre>
            </CollapsibleContent>
          </Collapsible>
          {props.runtimeStatus.cache.warmingMode !== "off" && (
            <Button
              type="button"
              className="cursor-pointer hover:text-accent"
              onClick={() => {
                props.onWarmingControl(
                  props.runtimeStatus?.cache.warming.state === "paused"
                    ? "resume"
                    : "stop",
                );
              }}
              title="Controls cache warming only; does not interrupt the foreground run"
            >
              {props.runtimeStatus.cache.warming.state === "paused"
                ? "Resume warming"
                : "Stop warming"}
            </Button>
          )}
        </div>
      )}
    </footer>
  );
}

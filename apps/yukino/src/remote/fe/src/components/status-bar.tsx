import { formatTokens } from "@fe/lib/format";

interface StatusBarProps {
  connection: "connecting" | "connected" | "reconnecting";
  usage: { inputTokens: number; outputTokens: number } | null;
  cwd: string;
  model: string;
  permissionMode: string;
  thinkingLevel: string;
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

/** Badge styling per permission mode; "default" shows no badge. */
const MODE_BADGE: Record<string, string> = {
  plan: "bg-accent/10 text-accent",
  bypassPermissions: "bg-red/10 text-red",
  acceptEdits: "bg-green/10 text-green",
};

const MODE_LABEL: Record<string, string> = {
  plan: "PLAN",
  bypassPermissions: "YOLO",
  acceptEdits: "AUTO-EDITS",
};

export function StatusBar({
  connection,
  usage,
  cwd,
  model,
  permissionMode,
  thinkingLevel,
}: StatusBarProps) {
  const usageText = usage
    ? `In: ${formatTokens(usage.inputTokens)} | Out: ${formatTokens(usage.outputTokens)}`
    : "";
  const modeBadge = MODE_BADGE[permissionMode];

  return (
    <header className="shrink-0 border-b border-border bg-surface/80 backdrop-blur">
      <div className="mx-auto flex w-full max-w-3xl items-center justify-between gap-3 px-5 py-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-accent text-xs font-bold text-white">
            S
          </span>
          <span className="shrink-0 text-sm font-semibold text-bright">
            Yukino Remote
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
        <div className="flex shrink-0 items-center gap-4 text-xs text-dim">
          {cwd && (
            <span
              className="hidden max-w-56 truncate font-mono text-[11px] xl:inline"
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

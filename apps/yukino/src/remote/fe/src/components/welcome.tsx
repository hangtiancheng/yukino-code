import type { ConnectionStatus } from "@fe/types";

export interface WelcomeInfo {
  session: string;
  cwd: string;
  model: string;
  thinkingLevel: string;
  permissionMode: string;
  connection: ConnectionStatus;
}

const QUICK_COMMANDS = ["/plan", "/code-review", "/resume", "/thinking"];

function DataRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline gap-3 py-1">
      <span className="w-20 shrink-0 text-xs text-dim">{label}</span>
      <span
        className="min-w-0 flex-1 truncate font-mono text-xs text-base"
        title={value}
      >
        {value}
      </span>
    </div>
  );
}

/**
 * Empty-state panel shown before the first message: a console-style status
 * card describing the live agent connection.
 */
export function Welcome(info: WelcomeInfo) {
  const connecting = info.connection !== "connected" || !info.session;

  return (
    <div className="flex min-h-full items-center justify-center py-10">
      <div className="w-full max-w-md rounded-xl border border-border bg-surface p-6 shadow-card">
        <div className="mb-4 flex items-center gap-2.5">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent text-sm font-bold text-white">
            S
          </span>
          <div>
            <p className="text-sm font-semibold text-bright">Yukino Remote</p>
            <p className="text-xs text-dim">
              {connecting ? "Connecting to the agent…" : "Agent connected"}
            </p>
          </div>
        </div>

        {!connecting && (
          <div className="mb-4 divide-y divide-border/60 rounded-lg border border-border/70 bg-bg px-3 py-1.5">
            <DataRow label="Session" value={info.session} />
            <DataRow label="Directory" value={info.cwd} />
            {info.model && <DataRow label="Model" value={info.model} />}
            {info.thinkingLevel && (
              <DataRow label="Thinking" value={info.thinkingLevel} />
            )}
            {info.permissionMode && info.permissionMode !== "default" && (
              <DataRow label="Mode" value={info.permissionMode} />
            )}
          </div>
        )}

        <p className="mb-2 text-[13px] text-base">
          {connecting
            ? "The session will appear here once the agent is ready."
            : "Describe a task below, or start with a command:"}
        </p>
        <div className="flex flex-wrap gap-1.5">
          {QUICK_COMMANDS.map((cmd) => (
            <span
              key={cmd}
              className="rounded-md border border-border bg-bg px-2 py-0.5 font-mono text-[11px] text-accent"
            >
              {cmd}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

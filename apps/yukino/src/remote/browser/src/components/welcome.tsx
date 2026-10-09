import type { ConnectionStatus } from "@browser/types";

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
    <div className="flex min-h-full items-center justify-center py-6 sm:py-10">
      <div className="w-full max-w-md rounded-xl border border-border bg-surface p-5 shadow-card sm:p-6">
        <div className="mb-4 flex items-center gap-2.5">
          <span
            className="flex h-9 w-9 items-center justify-center rounded-lg bg-accent/15 text-accent"
            aria-hidden="true"
          >
            <svg width="18" height="18" viewBox="0 0 16 16" fill="none">
              <path
                d="M8 1v14M8 1 6 3m2-2 2 2M8 15l-2-2m2 2 2-2M2 4.5l12 7M2 4.5l.4 2.7m-.4-2.7 2.6.7M14 11.5l-.4-2.7m.4 2.7-2.6-.7M14 4.5l-12 7M14 4.5l-2.6.7m2.6-.7-.4 2.7M2 11.5l.4-2.7m-.4 2.7 2.6-.7"
                stroke="currentColor"
                strokeWidth="1.2"
                strokeLinecap="round"
              />
            </svg>
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

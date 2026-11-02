import type { ConnectionStatus } from "#/types.js";

export interface WelcomeInfo {
  session: string;
  cwd: string;
  model: string;
  thinkingLevel: string;
  permissionMode: string;
  connection: ConnectionStatus;
}

export function Welcome(info: WelcomeInfo & { empty?: boolean }) {
  const connecting = info.connection !== "connected" || !info.session;
  return (
    <div
      className={`welcome border-b border-border px-1 pb-3 ${info.empty ? "pt-3 sm:pt-6" : ""}`}
    >
      <div className="flex items-center gap-2.5">
        <span
          aria-hidden="true"
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-border bg-surface text-lg text-accent"
        >
          ✳
        </span>
        <p>
          <strong className="text-lg font-semibold tracking-tight text-bright">
            Yukino
          </strong>
          <span className="ml-2 rounded-md border border-border px-1.5 py-0.5 font-mono text-[10px] text-muted">
            remote
          </span>
        </p>
      </div>
      <p className="mt-2.5 font-mono text-[11px] text-muted">
        Esc interrupt · /commands · ↑ history
      </p>
      <p className="mt-1 break-all font-mono text-xs text-dim">
        {connecting
          ? "Connecting to the agent…"
          : `${info.model} · ${info.cwd}`}
      </p>
      {!connecting && info.empty && (
        <p className="mt-4 mb-1 text-sm leading-relaxed text-muted">
          Describe a task, or type <span className="text-accent">/help</span> to
          get started.
        </p>
      )}
    </div>
  );
}

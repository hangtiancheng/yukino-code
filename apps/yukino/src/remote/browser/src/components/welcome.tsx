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
      className={`welcome border-b border-border px-1 pb-5 sm:px-2 ${info.empty ? "pt-6 sm:pt-12" : ""}`}
    >
      <div className="flex items-center gap-3">
        <span
          aria-hidden="true"
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-border bg-surface text-xl text-accent"
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
      <p className="mt-4 font-mono text-[11px] text-muted">
        Esc interrupt · /commands · ↑ history
      </p>
      <p className="mt-2 break-all font-mono text-xs text-dim">
        {connecting
          ? "Connecting to the agent…"
          : `${info.model} · ${info.cwd}`}
      </p>
      {!connecting && info.empty && (
        <p className="mt-6 mb-2 text-sm leading-relaxed text-muted">
          Describe a task, or type <span className="text-accent">/help</span> to
          get started.
        </p>
      )}
    </div>
  );
}

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
    <div className="px-3 py-4 sm:px-5">
      <p>
        <strong className="text-accent">Yukino</strong>
        <span className="text-dim"> · remote</span>
      </p>
      <p className="mt-1 text-muted">Esc interrupt · /commands · ↑ history</p>
      <p className="mt-1 break-all text-dim">
        {connecting
          ? "Connecting to the agent…"
          : `${info.model} · ${info.cwd}`}
      </p>
      {!connecting && info.empty && (
        <p className="mt-6 text-muted">
          Describe a task, or type <span className="text-accent">/help</span> to
          get started.
        </p>
      )}
    </div>
  );
}

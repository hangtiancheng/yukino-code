import type {
  BackgroundTaskInfo,
  SubagentInfo,
  TeammateInfo,
} from "@browser/types";

import { Modal, ModalHeader } from "./modal";

interface ActivityPanelProps {
  subagents: SubagentInfo[];
  backgroundTasks: BackgroundTaskInfo[];
  teammates: TeammateInfo[];
  onClose: () => void;
}

const STATUS_PILL: Record<string, string> = {
  running: "bg-yellow/15 text-yellow",
  completed: "bg-green/15 text-green",
  failed: "bg-red/15 text-red",
  stopped: "bg-red/15 text-red",
  cancelled: "bg-red/15 text-red",
  idle: "bg-accent/15 text-accent",
};

function Pill({ status }: { status: string }) {
  return (
    <span
      className={`shrink-0 rounded-full px-2 py-0.5 font-mono text-[10px] font-semibold ${STATUS_PILL[status] ?? "bg-accent/15 text-accent"}`}
    >
      {status}
    </span>
  );
}

/** Agents panel: subagents, background tasks and teammates (TUI Agents list parity). */
export function ActivityPanel({
  subagents,
  backgroundTasks,
  teammates,
  onClose,
}: ActivityPanelProps) {
  const empty =
    subagents.length === 0 &&
    backgroundTasks.length === 0 &&
    teammates.length === 0;

  return (
    <Modal label="Agents and background tasks" onEscape={onClose}>
      <ModalHeader
        subtitle="Live activity across subagents, background tasks and teammates."
        title="Agents"
      />
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4 sm:px-5">
        {empty && (
          <p className="text-sm text-dim">
            No subagents, background tasks or teammates right now.
          </p>
        )}
        {subagents.length > 0 && (
          <section>
            <h3 className="mb-1.5 text-xs font-semibold tracking-wide text-dim uppercase">
              Subagents
            </h3>
            <div className="space-y-1.5">
              {subagents.map((agent) => (
                <div
                  key={agent.toolCallId}
                  className="rounded-lg border border-border bg-bg px-3 py-2"
                >
                  <div className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate font-mono text-[13px] text-bright">
                      {agent.role}
                      {agent.background ? " · background" : ""}
                    </span>
                    <span className="shrink-0 font-mono text-[11px] text-dim tabular-nums">
                      {`${String(agent.turnCount)} turns`}
                    </span>
                    <Pill status={agent.status} />
                  </div>
                  {agent.status === "running" &&
                    agent.activeTools.length > 0 && (
                      <p className="mt-1 truncate font-mono text-[11px] text-dim">
                        {agent.activeTools
                          .map((tool) => tool.toolName)
                          .join(", ")}
                      </p>
                    )}
                </div>
              ))}
            </div>
          </section>
        )}
        {backgroundTasks.length > 0 && (
          <section>
            <h3 className="mb-1.5 text-xs font-semibold tracking-wide text-dim uppercase">
              Background tasks
            </h3>
            <div className="space-y-1.5">
              {backgroundTasks.map((task) => (
                <div
                  key={task.id}
                  className="flex items-center gap-2 rounded-lg border border-border bg-bg px-3 py-2"
                >
                  <span className="min-w-0 flex-1 truncate font-mono text-[13px] text-bright">
                    {task.name}
                    <span className="ml-2 text-[11px] text-dim">
                      {task.kind}
                    </span>
                  </span>
                  <Pill status={task.status} />
                </div>
              ))}
            </div>
          </section>
        )}
        {teammates.length > 0 && (
          <section>
            <h3 className="mb-1.5 text-xs font-semibold tracking-wide text-dim uppercase">
              Teammates
            </h3>
            <div className="space-y-1.5">
              {teammates.map((mate) => (
                <div
                  key={`${mate.teamName}_${mate.name}`}
                  className="rounded-lg border border-border bg-bg px-3 py-2"
                >
                  <div className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate font-mono text-[13px] text-bright">
                      {`${mate.teamName}/${mate.name}`}
                    </span>
                    <span className="shrink-0 font-mono text-[11px] text-dim tabular-nums">
                      {`${String(mate.turnCount)} turns · ${String(mate.toolUseCount)} tools`}
                    </span>
                    <Pill status={mate.status} />
                  </div>
                  {mate.status === "running" && (
                    <p className="mt-1 truncate font-mono text-[11px] text-dim">
                      {mate.spinnerVerb}
                      {mate.activeTools.length > 0
                        ? ` · ${mate.activeTools.map((tool) => tool.toolName).join(", ")}`
                        : ""}
                      {mate.lastMessage ? ` · ${mate.lastMessage}` : ""}
                    </p>
                  )}
                </div>
              ))}
            </div>
          </section>
        )}
      </div>
      <div className="flex items-center justify-end border-t border-border px-4 py-3 sm:px-5">
        <button
          type="button"
          onClick={onClose}
          className="cursor-pointer rounded-lg border border-border px-3.5 py-1.5 text-[13px] font-semibold text-base transition-colors hover:bg-bg"
        >
          Close
        </button>
      </div>
    </Modal>
  );
}

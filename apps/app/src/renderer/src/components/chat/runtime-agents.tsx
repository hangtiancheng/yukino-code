import { RuntimeStatus } from "@renderer/components/chat/runtime-status";
import { Button } from "@renderer/components/ui/button";
import type { RuntimeAction, RuntimeSnapshot } from "@shared/workspace-types";
import { BotIcon, SquareIcon, TerminalIcon, UsersIcon } from "lucide-react";

export function RuntimeAgents({
  data,
  busy,
  onAction,
}: {
  data: RuntimeSnapshot;
  busy: boolean;
  onAction: (action: RuntimeAction) => void;
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-[22px]">
      <section className="[&+&]:border-border flex min-w-0 flex-col gap-3 [&+&]:border-t [&+&]:pt-[22px]">
        <h3 className="[&>svg]:text-accent-foreground mb-0.5 flex min-h-[25px] items-center gap-2 text-xs font-semibold [&>svg]:size-[15px] [&>svg]:shrink-0">
          <BotIcon />
          Subagents
          <span className="bg-muted text-muted-foreground inline-flex rounded-[5px] px-1.5 py-0.5 text-[9px] font-normal tabular-nums">
            {data.subagents.length}
          </span>
        </h3>
        {data.subagents.length ? (
          data.subagents.map((agent) => (
            <div
              className="border-border [&_p]:text-muted-foreground flex items-center gap-2.5 rounded-[10px] border p-3 [&_p]:mt-[5px] [&_p]:text-[9px] [&_p]:leading-[1.6] [&_strong]:text-[11px] [&_strong]:font-[550]"
              key={agent.id}
            >
              <div className="bg-secondary text-accent-foreground grid size-8 shrink-0 place-items-center rounded-[9px] [&_svg]:size-[17px]">
                <BotIcon />
              </div>
              <div className="min-w-0 flex-1">
                <strong>{agent.role}</strong>
                <p>
                  {agent.background ? "Background" : "Foreground"} ·{" "}
                  {agent.turns} turns · {agent.tools} tool calls
                  {agent.activity ? ` · ${agent.activity}` : ""}
                </p>
              </div>
              <RuntimeStatus status={agent.status} />
            </div>
          ))
        ) : (
          <p className="text-muted-foreground py-2 text-[11px]">No subagents</p>
        )}
      </section>
      <section className="[&+&]:border-border flex min-w-0 flex-col gap-3 [&+&]:border-t [&+&]:pt-[22px]">
        <h3 className="[&>svg]:text-accent-foreground mb-0.5 flex min-h-[25px] items-center gap-2 text-xs font-semibold [&>svg]:size-[15px] [&>svg]:shrink-0">
          <UsersIcon />
          Team
          <span className="bg-muted text-muted-foreground inline-flex rounded-[5px] px-1.5 py-0.5 text-[9px] font-normal tabular-nums">
            {data.teammates.length}
          </span>
        </h3>
        {data.teammates.length ? (
          data.teammates.map((member) => (
            <div
              className="border-border [&_p]:text-muted-foreground [&_strong_small]:text-muted-foreground flex items-center gap-2.5 rounded-[10px] border p-3 [&_p]:mt-[5px] [&_p]:text-[9px] [&_p]:leading-[1.6] [&_strong]:text-[11px] [&_strong]:font-[550] [&_strong_small]:ml-[7px] [&_strong_small]:text-[9px] [&_strong_small]:font-normal"
              key={`${member.teamName}/${member.name}`}
            >
              <div className="bg-secondary text-accent-foreground grid size-8 shrink-0 place-items-center rounded-[9px] [&_svg]:size-[17px]">
                <UsersIcon />
              </div>
              <div className="min-w-0 flex-1">
                <strong>
                  {member.name}
                  <small>{member.teamName}</small>
                </strong>
                <p>
                  {member.progress.turnCount} turns ·{" "}
                  {member.progress.toolUseCount} tool calls ·{" "}
                  {member.progress.tokenCount.toLocaleString()} tokens
                </p>
                {member.progress.lastActivity ? (
                  <p className="truncate">
                    {member.progress.lastActivity.activityDescription}
                  </p>
                ) : null}
                {member.lastMessage ? (
                  <details>
                    <summary className="text-accent-foreground text-xs">
                      Latest message
                    </summary>
                    <pre className="border-border bg-background mt-2.5 max-h-[260px] overflow-auto rounded-[7px] border p-3 font-mono text-[10px] leading-[1.7] wrap-anywhere whitespace-pre-wrap">
                      {member.lastMessage}
                    </pre>
                  </details>
                ) : null}
              </div>
              <RuntimeStatus status={member.status} />
              {["running", "idle"].includes(member.status) ? (
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={`Stop ${member.name}`}
                  disabled={busy}
                  onClick={() => {
                    onAction({
                      type: "stop_teammate",
                      team: member.teamName,
                      name: member.name,
                    });
                  }}
                >
                  <SquareIcon />
                </Button>
              ) : null}
            </div>
          ))
        ) : (
          <p className="text-muted-foreground py-2 text-[11px]">
            No team members
          </p>
        )}
      </section>
      <section className="[&+&]:border-border flex min-w-0 flex-col gap-3 [&+&]:border-t [&+&]:pt-[22px]">
        <h3 className="[&>svg]:text-accent-foreground mb-0.5 flex min-h-[25px] items-center gap-2 text-xs font-semibold [&>svg]:size-[15px] [&>svg]:shrink-0">
          <TerminalIcon />
          Background tasks
          <span className="bg-muted text-muted-foreground inline-flex rounded-[5px] px-1.5 py-0.5 text-[9px] font-normal tabular-nums">
            {data.backgroundTasks.length}
          </span>
        </h3>
        {data.backgroundTasks.length ? (
          data.backgroundTasks.map((task) => (
            <div
              className="border-border [&_summary]:text-accent-foreground flex flex-col gap-[9px] rounded-[10px] border p-3.5 text-[11px] [&_summary]:cursor-pointer [&_summary]:text-[10px]"
              key={task.id}
            >
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate font-medium">
                  {task.name}
                </span>
                <RuntimeStatus status={task.status} />
                {task.status === "running" ? (
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Stop ${task.name}`}
                    disabled={busy}
                    onClick={() => {
                      onAction({ type: "stop_task", id: task.id });
                    }}
                  >
                    <SquareIcon />
                  </Button>
                ) : null}
              </div>
              <p className="text-muted-foreground text-xs">
                {task.kind} · {new Date(task.startedAt).toLocaleTimeString()}
              </p>
              <details>
                <summary>View output</summary>
                <pre className="border-border bg-background mt-2.5 max-h-[260px] overflow-auto rounded-[7px] border p-3 font-mono text-[10px] leading-[1.7] wrap-anywhere whitespace-pre-wrap">
                  {task.output || "No output"}
                </pre>
              </details>
            </div>
          ))
        ) : (
          <p className="text-muted-foreground py-2 text-[11px]">
            No background tasks
          </p>
        )}
      </section>
    </div>
  );
}

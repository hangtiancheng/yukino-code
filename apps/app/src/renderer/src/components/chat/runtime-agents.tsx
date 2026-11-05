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
    <div className="runtime-stack">
      <section className="runtime-section">
        <h3 className="runtime-heading">
          <BotIcon />子 Agent
          <span className="runtime-count">{data.subagents.length}</span>
        </h3>
        {data.subagents.length ? (
          data.subagents.map((agent) => (
            <div className="agent-card" key={agent.id}>
              <div className="agent-avatar">
                <BotIcon />
              </div>
              <div className="min-w-0 flex-1">
                <strong>{agent.role}</strong>
                <p>
                  {agent.background ? "后台" : "前台"} · {agent.turns} 轮次 ·{" "}
                  {agent.tools} 次工具调用
                  {agent.activity ? ` · ${agent.activity}` : ""}
                </p>
              </div>
              <RuntimeStatus status={agent.status} />
            </div>
          ))
        ) : (
          <p className="runtime-empty">暂无子 Agent</p>
        )}
      </section>
      <section className="runtime-section">
        <h3 className="runtime-heading">
          <UsersIcon />
          团队<span className="runtime-count">{data.teammates.length}</span>
        </h3>
        {data.teammates.length ? (
          data.teammates.map((member) => (
            <div
              className="agent-card"
              key={`${member.teamName}/${member.name}`}
            >
              <div className="agent-avatar">
                <UsersIcon />
              </div>
              <div className="min-w-0 flex-1">
                <strong>
                  {member.name}
                  <small>{member.teamName}</small>
                </strong>
                <p>
                  {member.progress.turnCount} 轮次 ·{" "}
                  {member.progress.toolUseCount} 次工具调用 ·{" "}
                  {member.progress.tokenCount.toLocaleString()} tokens
                </p>
                {member.progress.lastActivity ? (
                  <p className="truncate">
                    {member.progress.lastActivity.activityDescription}
                  </p>
                ) : null}
                {member.lastMessage ? (
                  <details>
                    <summary className="text-primary text-xs">最近消息</summary>
                    <pre className="runtime-output">{member.lastMessage}</pre>
                  </details>
                ) : null}
              </div>
              <RuntimeStatus status={member.status} />
              {["running", "idle"].includes(member.status) ? (
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={`停止 ${member.name}`}
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
          <p className="runtime-empty">暂无团队成员</p>
        )}
      </section>
      <section className="runtime-section">
        <h3 className="runtime-heading">
          <TerminalIcon />
          后台任务
          <span className="runtime-count">{data.backgroundTasks.length}</span>
        </h3>
        {data.backgroundTasks.length ? (
          data.backgroundTasks.map((task) => (
            <div className="background-card" key={task.id}>
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate font-medium">
                  {task.name}
                </span>
                <RuntimeStatus status={task.status} />
                {task.status === "running" ? (
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`停止 ${task.name}`}
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
                <summary>查看输出</summary>
                <pre className="runtime-output">
                  {task.output || "暂无输出"}
                </pre>
              </details>
            </div>
          ))
        ) : (
          <p className="runtime-empty">暂无后台任务</p>
        )}
      </section>
    </div>
  );
}

import { RuntimeStatus } from "@renderer/components/chat/runtime-status";
import { Button } from "@renderer/components/ui/button";
import { Input } from "@renderer/components/ui/input";
import type { RuntimeAction, RuntimeSnapshot } from "@shared/workspace-types";
import {
  CheckIcon,
  ListChecksIcon,
  PauseIcon,
  PlayIcon,
  TargetIcon,
  Trash2Icon,
} from "lucide-react";
import { useState } from "react";

export function RuntimeTasks({
  data,
  streaming,
  busy,
  onAction,
  onPrompt,
}: {
  data: RuntimeSnapshot;
  streaming: boolean;
  busy: boolean;
  onAction: (action: RuntimeAction) => void;
  onPrompt: (value: string) => void;
}): React.JSX.Element {
  const [objective, setObjective] = useState("");
  const [budget, setBudget] = useState("");
  const goal = data.goal;
  const completed = data.tasks.filter(
    (task) => task.status === "completed",
  ).length;
  return (
    <div className="runtime-stack">
      <section className="runtime-section">
        <h3 className="runtime-heading">
          <TargetIcon />
          持续目标{goal ? <RuntimeStatus status={goal.status} /> : null}
        </h3>
        {goal ? (
          <>
            <p className="goal-objective">{goal.objective}</p>
            <div className="goal-metrics">
              <span>
                <strong>{goal.turnsExecuted}</strong>轮次
              </span>
              <span>
                <strong>{Math.round(goal.activeMs / 60000)}</strong>分钟
              </span>
              <span>
                <strong>{goal.tokensUsed.toLocaleString()}</strong>
                {goal.tokenBudget === null
                  ? "tokens"
                  : `/ ${goal.tokenBudget.toLocaleString()} tokens`}
              </span>
            </div>
            {goal.tokenBudget !== null ? (
              <progress
                className="runtime-progress"
                aria-label="目标预算用量"
                max={goal.tokenBudget}
                value={Math.min(goal.tokensUsed, goal.tokenBudget)}
              />
            ) : null}
            {goal.lastBlockReason ? (
              <p className="text-warning text-xs">{goal.lastBlockReason}</p>
            ) : null}
            <div className="flex gap-2">
              {goal.status === "active" ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => {
                    onAction({ type: "pause_goal" });
                  }}
                >
                  <PauseIcon />
                  暂停目标
                </Button>
              ) : ["paused", "blocked", "max_turns"].includes(goal.status) ? (
                <Button
                  size="sm"
                  disabled={streaming || busy}
                  onClick={() => {
                    onPrompt(
                      goal.status === "max_turns"
                        ? "/goal continue"
                        : "/goal resume",
                    );
                  }}
                >
                  <PlayIcon />
                  继续目标
                </Button>
              ) : null}
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="清除目标"
                disabled={streaming || busy}
                onClick={() => {
                  onAction({ type: "clear_goal" });
                }}
              >
                <Trash2Icon />
              </Button>
            </div>
          </>
        ) : (
          <form
            className="goal-form"
            onSubmit={(event) => {
              event.preventDefault();
              if (objective.trim()) {
                onPrompt(
                  `/goal ${budget ? `--budget ${budget} ` : ""}${objective.trim()}`,
                );
              }
            }}
          >
            <Input
              aria-label="目标"
              placeholder="设置一个持续推进的目标…"
              value={objective}
              onChange={(event) => {
                setObjective(event.target.value);
              }}
              maxLength={4000}
              disabled={streaming}
              required
            />
            <div className="flex gap-2">
              <Input
                className="max-w-48"
                aria-label="Token 预算"
                placeholder="Token 预算（可选）"
                type="number"
                min={1}
                max={Number.MAX_SAFE_INTEGER}
                step={1}
                value={budget}
                onChange={(event) => {
                  setBudget(event.target.value);
                }}
                disabled={streaming}
              />
              <Button
                size="sm"
                type="submit"
                disabled={streaming || !objective.trim()}
              >
                <PlayIcon />
                开始
              </Button>
            </div>
          </form>
        )}
      </section>
      <section className="runtime-section">
        <h3 className="runtime-heading">
          <ListChecksIcon />
          任务清单
          <span className="runtime-count">
            {completed} / {data.tasks.length}
          </span>
        </h3>
        {data.tasks.length ? (
          <>
            <progress
              className="runtime-progress"
              aria-label="任务完成进度"
              max={data.tasks.length}
              value={completed}
            />
            {data.tasks.map((task) => (
              <details className="task-detail" key={task.id}>
                <summary>
                  <span
                    className={`task-check ${task.status === "completed" ? "checked" : ""}`}
                  >
                    {task.status === "completed" ? <CheckIcon /> : task.id}
                  </span>
                  <span className="min-w-0 flex-1">{task.subject}</span>
                  <RuntimeStatus status={task.status} />
                </summary>
                <div className="task-description">
                  {task.description || task.subject}
                  {task.owner ? <p>负责人 · {task.owner}</p> : null}
                  {task.blockedBy.length ? (
                    <p>前置任务 · {task.blockedBy.join(", ")}</p>
                  ) : null}
                  {task.priority ? (
                    <p>
                      优先级 ·{" "}
                      {{ high: "高", medium: "中", low: "低" }[task.priority]}
                    </p>
                  ) : null}
                </div>
              </details>
            ))}
          </>
        ) : (
          <div className="runtime-empty-state">
            <ListChecksIcon />
            <span>暂无任务</span>
          </div>
        )}
      </section>
    </div>
  );
}

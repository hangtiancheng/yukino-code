import { RuntimeStatus } from "@renderer/components/chat/runtime-status";
import { Button } from "@renderer/components/ui/button";
import { Input } from "@renderer/components/ui/input";
import type { RuntimeAction, RuntimeSnapshot } from "@shared/workspace-types";
import { cn } from "cn";
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
    <div className="flex flex-col gap-[22px]">
      <section className="[&+&]:border-border flex min-w-0 flex-col gap-3 [&+&]:border-t [&+&]:pt-[22px]">
        <h3 className="[&>svg]:text-accent-foreground mb-0.5 flex min-h-[25px] items-center gap-2 text-xs font-semibold [&>svg]:size-[15px] [&>svg]:shrink-0">
          <TargetIcon />
          持续目标
          {goal ? (
            <RuntimeStatus className="ml-auto" status={goal.status} />
          ) : null}
        </h3>
        {goal ? (
          <>
            <p className="text-sm leading-[1.8] font-medium wrap-anywhere">
              {goal.objective}
            </p>
            <div className="[&>span]:text-muted-foreground [&>span>strong]:text-foreground flex items-center gap-[26px] py-[7px] [&>span]:flex [&>span]:flex-col [&>span]:gap-[3px] [&>span]:text-[9px] [&>span>strong]:text-[19px] [&>span>strong]:font-[550] [&>span>strong]:tracking-[-0.5px] [&>span>strong]:tabular-nums">
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
                className="bg-muted [&::-moz-progress-bar]:bg-primary [&::-webkit-progress-bar]:bg-muted [&::-webkit-progress-value]:bg-primary h-1 w-full appearance-none overflow-hidden rounded-[3px] border-0 [&::-moz-progress-bar]:rounded-[3px] [&::-webkit-progress-bar]:rounded-[3px] [&::-webkit-progress-value]:rounded-[3px] [&::-webkit-progress-value]:transition-[width] [&::-webkit-progress-value]:duration-[250ms]"
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
            className="flex flex-col gap-2.5"
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
              className="text-[11px] md:text-[11px]"
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
                className="max-w-48 text-[11px] md:text-[11px]"
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
      <section className="[&+&]:border-border flex min-w-0 flex-col gap-3 [&+&]:border-t [&+&]:pt-[22px]">
        <h3 className="[&>svg]:text-accent-foreground mb-0.5 flex min-h-[25px] items-center gap-2 text-xs font-semibold [&>svg]:size-[15px] [&>svg]:shrink-0">
          <ListChecksIcon />
          任务清单
          <span className="bg-muted text-muted-foreground inline-flex rounded-[5px] px-1.5 py-0.5 text-[9px] font-normal tabular-nums">
            {completed} / {data.tasks.length}
          </span>
        </h3>
        {data.tasks.length ? (
          <>
            <progress
              className="bg-muted [&::-moz-progress-bar]:bg-primary [&::-webkit-progress-bar]:bg-muted [&::-webkit-progress-value]:bg-primary h-1 w-full appearance-none overflow-hidden rounded-[3px] border-0 [&::-moz-progress-bar]:rounded-[3px] [&::-webkit-progress-bar]:rounded-[3px] [&::-webkit-progress-value]:rounded-[3px] [&::-webkit-progress-value]:transition-[width] [&::-webkit-progress-value]:duration-[250ms]"
              aria-label="任务完成进度"
              max={data.tasks.length}
              value={completed}
            />
            {data.tasks.map((task) => (
              <details className="border-border border-b" key={task.id}>
                <summary className="flex cursor-pointer list-none items-center gap-[9px] py-2.5 text-[11px]">
                  <span
                    className={cn(
                      "border-input text-muted-foreground grid size-[19px] shrink-0 place-items-center rounded-[6px] border text-[8px] [&>svg]:size-[11px]",
                      task.status === "completed" &&
                        "text-success border-[color-mix(in_srgb,var(--success)_35%,var(--border))] bg-[color-mix(in_srgb,var(--success)_7%,transparent)]",
                    )}
                  >
                    {task.status === "completed" ? <CheckIcon /> : task.id}
                  </span>
                  <span className="min-w-0 flex-1">{task.subject}</span>
                  <RuntimeStatus status={task.status} />
                </summary>
                <div className="text-muted-foreground px-0 pb-[13px] pl-7 text-[11px] leading-[1.8] wrap-anywhere whitespace-pre-wrap [&_p]:mt-[7px]">
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
          <div className="border-border text-muted-foreground flex flex-col items-center justify-center gap-3 rounded-[10px] border border-dashed p-9 text-[11px] [&>svg]:size-[27px] [&>svg]:opacity-45">
            <ListChecksIcon />
            <span>暂无任务</span>
          </div>
        )}
      </section>
    </div>
  );
}

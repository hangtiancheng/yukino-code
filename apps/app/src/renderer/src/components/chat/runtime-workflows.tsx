import { RuntimeStatus } from "@renderer/components/chat/runtime-status";
import { Button } from "@renderer/components/ui/button";
import type { RuntimeSnapshot } from "@shared/workspace-types";
import { cn } from "cn";
import { GitBranchIcon, PlayIcon, WorkflowIcon } from "lucide-react";

export function RuntimeWorkflows({
  data,
  disabled,
  onPrompt,
}: {
  data: RuntimeSnapshot;
  disabled: boolean;
  onPrompt: (value: string) => void;
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-[22px]">
      <section className="[&+&]:border-border flex min-w-0 flex-col gap-3 [&+&]:border-t [&+&]:pt-[22px]">
        <h3 className="[&>svg]:text-accent-foreground mb-0.5 flex min-h-[25px] items-center gap-2 text-xs font-semibold [&>svg]:size-[15px] [&>svg]:shrink-0">
          <WorkflowIcon />
          工作流
        </h3>
        {data.namedWorkflows.length ? (
          <div className="[&_button]:border-border [&_button:hover]:bg-secondary [&_svg]:text-accent-foreground grid grid-cols-2 gap-2.5 [&_button]:flex [&_button]:items-center [&_button]:gap-[9px] [&_button]:rounded-[9px] [&_button]:border [&_button]:p-3.5 [&_button]:text-left [&_strong]:flex-1 [&_strong]:overflow-hidden [&_strong]:text-[11px] [&_strong]:font-medium [&_strong]:text-ellipsis [&_svg]:size-[15px] [&_svg]:shrink-0 [&_svg:last-child]:w-3">
            {data.namedWorkflows.map((name) => (
              <button
                disabled={disabled}
                key={name}
                onClick={() => {
                  onPrompt(`/${name}`);
                }}
              >
                <GitBranchIcon />
                <strong>{name}</strong>
                <PlayIcon />
              </button>
            ))}
          </div>
        ) : (
          <p className="text-muted-foreground py-2 text-[11px]">
            暂无项目工作流
          </p>
        )}
        <Button
          variant="outline"
          size="sm"
          disabled={disabled}
          onClick={() => {
            onPrompt("/workflows");
          }}
        >
          管理工作流
        </Button>
      </section>
      {data.workflows.map((run) => (
        <section
          className="[&+&]:border-border flex min-w-0 flex-col gap-3 [&+&]:border-t [&+&]:pt-[22px]"
          key={run.runId}
        >
          <h3 className="[&>svg]:text-accent-foreground mb-0.5 flex min-h-[25px] items-center gap-2 text-xs font-semibold [&>svg]:size-[15px] [&>svg]:shrink-0">
            <GitBranchIcon />
            {run.workflowName}
            <RuntimeStatus className="ml-auto" status={run.status} />
          </h3>
          {run.description ? (
            <p className="text-muted-foreground text-xs">{run.description}</p>
          ) : null}
          <ol className="[&>li:not(:last-child)]:after:bg-border flex flex-col py-[7px] [&_strong]:flex-1 [&_strong]:text-[11px] [&_strong]:font-medium [&>li]:relative [&>li]:flex [&>li]:items-center [&>li]:gap-2.5 [&>li]:py-[11px] [&>li:not(:last-child)]:after:absolute [&>li:not(:last-child)]:after:top-9 [&>li:not(:last-child)]:after:left-[11px] [&>li:not(:last-child)]:after:h-[21px] [&>li:not(:last-child)]:after:w-px [&>li:not(:last-child)]:after:content-['']">
            {run.phases.map((phase, index) => (
              <li key={`${index}/${phase.title}`}>
                <span
                  className={cn(
                    "border-border bg-muted text-muted-foreground grid size-[23px] place-items-center rounded-full border text-[9px]",
                    phase.status === "running" &&
                      "border-ring bg-secondary text-accent-foreground",
                    phase.status === "done" &&
                      "text-success bg-[color-mix(in_srgb,var(--success)_10%,transparent)]",
                  )}
                >
                  {index + 1}
                </span>
                <strong>{phase.title}</strong>
                <RuntimeStatus status={phase.status} />
              </li>
            ))}
          </ol>
          {run.agents.map((agent) => (
            <div
              className="border-border flex min-w-0 items-center gap-[9px] border-b py-2.5 text-[11px] [&_strong]:font-medium"
              key={agent.id}
            >
              <span>{agent.label ?? `Agent ${agent.id}`}</span>
              <span className="text-muted-foreground ml-auto text-xs">
                {agent.tokenCount.toLocaleString()} tokens · {agent.toolCount}{" "}
                次调用
              </span>
              <RuntimeStatus status={agent.status} />
            </div>
          ))}
          {run.error ? (
            <p role="alert" className="text-destructive text-xs">
              {run.error}
            </p>
          ) : null}
          {run.logs.length ? (
            <details>
              <summary className="text-muted-foreground text-xs">
                运行日志
              </summary>
              <pre className="border-border bg-background mt-2.5 max-h-[260px] overflow-auto rounded-[7px] border p-3 font-mono text-[10px] leading-[1.7] wrap-anywhere whitespace-pre-wrap">
                {run.logs.join("\n")}
              </pre>
            </details>
          ) : null}
          {run.status === "failed" || run.status === "killed" ? (
            <Button
              size="sm"
              variant="outline"
              disabled={disabled}
              onClick={() => {
                onPrompt(`/workflows resume ${run.runId}`);
              }}
            >
              <PlayIcon />
              恢复运行
            </Button>
          ) : null}
        </section>
      ))}
    </div>
  );
}

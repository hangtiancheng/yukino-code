import { RuntimeStatus } from "@renderer/components/chat/runtime-status";
import { Button } from "@renderer/components/ui/button";
import type { RuntimeSnapshot } from "@shared/workspace-types";
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
    <div className="runtime-stack">
      <section className="runtime-section">
        <h3 className="runtime-heading">
          <WorkflowIcon />
          工作流
        </h3>
        {data.namedWorkflows.length ? (
          <div className="named-workflows">
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
          <p className="runtime-empty">暂无项目工作流</p>
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
        <section className="runtime-section" key={run.runId}>
          <h3 className="runtime-heading">
            <GitBranchIcon />
            {run.workflowName}
            <RuntimeStatus status={run.status} />
          </h3>
          {run.description ? (
            <p className="text-muted-foreground text-xs">{run.description}</p>
          ) : null}
          <ol className="workflow-phases">
            {run.phases.map((phase, index) => (
              <li key={`${index}/${phase.title}`}>
                <span className={`phase-marker ${phase.status}`}>
                  {index + 1}
                </span>
                <strong>{phase.title}</strong>
                <RuntimeStatus status={phase.status} />
              </li>
            ))}
          </ol>
          {run.agents.map((agent) => (
            <div className="runtime-row" key={agent.id}>
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
              <pre className="runtime-output">{run.logs.join("\n")}</pre>
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

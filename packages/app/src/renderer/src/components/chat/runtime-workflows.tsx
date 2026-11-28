import { RuntimeStatus } from "@renderer/components/chat/runtime-status";
import { Button } from "@renderer/components/ui/button";
import { Input } from "@renderer/components/ui/input";
import { ChoiceSelect } from "@renderer/components/ui/select";
import { Textarea } from "@renderer/components/ui/textarea";
import type { AgentControl } from "@shared/agent-types";
import type { RuntimeSnapshot } from "@shared/workspace-types";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { WorkflowInput } from "@yukino.js/yukino";
import { cn } from "cn";
import {
  GitBranchIcon,
  PlayIcon,
  SquareIcon,
  WorkflowIcon,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

export function RuntimeWorkflows({
  data,
  disabled,
}: {
  data: RuntimeSnapshot;
  disabled: boolean;
}): React.JSX.Element {
  const client = useQueryClient();
  const control = useMutation({
    mutationFn: (action: AgentControl) => window.api.controlAgent(action),
    onSuccess: async (_, action) => {
      await client.invalidateQueries({ queryKey: ["runtime"] });
      if (action.type === "workflow_run") {
        toast.success(
          action.input.resumeFromRunId
            ? "Workflow resumed"
            : "Workflow started",
        );
      }
    },
    onError: (error) => toast.error(error.message),
  });
  const [source, setSource] = useState<"named" | "file" | "inline">("named");
  const [name, setName] = useState("");
  const [scriptPath, setScriptPath] = useState("");
  const [script, setScript] = useState("");
  const [args, setArgs] = useState("");
  const [concurrency, setConcurrency] = useState("");
  const [formError, setFormError] = useState("");
  const selectedName = data.namedWorkflows.includes(name)
    ? name
    : (data.namedWorkflows[0] ?? "");
  const busy = control.isPending;
  const launch = (): void => {
    let json: WorkflowInput["args"];
    try {
      json = args.trim()
        ? (JSON.parse(args) as WorkflowInput["args"])
        : undefined;
    } catch {
      setFormError("Arguments must be valid JSON.");
      return;
    }
    setFormError("");
    control.mutate({
      type: "workflow_run",
      input: {
        ...(source === "named"
          ? { name: selectedName }
          : source === "file"
            ? { scriptPath: scriptPath.trim() }
            : { script }),
        ...(json === undefined ? {} : { args: json }),
        ...(concurrency ? { maxConcurrency: Number(concurrency) } : {}),
      },
    });
  };
  return (
    <div className="flex flex-col gap-[22px]">
      <form
        className="bg-muted/35 flex min-w-0 flex-col gap-3 rounded-xl border p-4"
        onSubmit={(event) => {
          event.preventDefault();
          launch();
        }}
      >
        <h3 className="flex items-center gap-2 text-sm font-semibold">
          <WorkflowIcon className="text-accent-foreground size-4" />
          Launch workflow
        </h3>
        <div className="grid min-w-0 grid-cols-[1fr_1.5fr] gap-2 @max-[390px]/workbench:grid-cols-1">
          <ChoiceSelect
            label="Workflow source"
            value={source}
            onValueChange={setSource}
            options={[
              { value: "named", label: "Project workflow" },
              { value: "file", label: "Script path" },
              { value: "inline", label: "Inline JavaScript" },
            ]}
          />
          {source === "named" ? (
            <ChoiceSelect
              label="Project workflow"
              value={selectedName}
              onValueChange={setName}
              disabled={!data.namedWorkflows.length}
              options={
                data.namedWorkflows.length
                  ? data.namedWorkflows.map((value) => ({
                      value,
                      label: value,
                    }))
                  : [{ value: "", label: "No project workflows" }]
              }
            />
          ) : source === "file" ? (
            <Input
              aria-label="Workflow script path"
              placeholder=".yukino/workflows/release.js"
              value={scriptPath}
              onChange={(event) => {
                setScriptPath(event.target.value);
              }}
              required
            />
          ) : null}
        </div>
        {source === "inline" ? (
          <Textarea
            className="min-h-24 font-mono text-xs"
            aria-label="Workflow JavaScript"
            value={script}
            onChange={(event) => {
              setScript(event.target.value);
            }}
            required
          />
        ) : null}
        <div className="grid min-w-0 grid-cols-[1.5fr_1fr] gap-2 @max-[390px]/workbench:grid-cols-1">
          <Input
            className="font-mono text-xs"
            aria-label="Workflow arguments (JSON)"
            placeholder="Arguments (JSON, optional)"
            value={args}
            onChange={(event) => {
              setArgs(event.target.value);
              setFormError("");
            }}
          />
          <Input
            type="number"
            min={1}
            step={1}
            aria-label="Workflow concurrency"
            placeholder="Concurrency (optional)"
            value={concurrency}
            onChange={(event) => {
              setConcurrency(event.target.value);
            }}
          />
        </div>
        {formError ? (
          <p role="alert" className="text-destructive text-xs">
            {formError}
          </p>
        ) : null}
        <Button
          className="self-start"
          type="submit"
          disabled={disabled || busy || (source === "named" && !selectedName)}
        >
          <PlayIcon /> Run workflow
        </Button>
      </form>
      {data.workflows.map((run) => (
        <section
          className="[&+&]:border-border flex min-w-0 flex-col gap-3 [&+&]:border-t [&+&]:pt-[22px]"
          key={run.runId}
        >
          <h3 className="[&>svg]:text-accent-foreground mb-0.5 flex min-h-[25px] items-center gap-2 text-xs font-semibold [&>svg]:size-[15px] [&>svg]:shrink-0">
            <GitBranchIcon />
            <span className="min-w-0 flex-1 wrap-anywhere">
              {run.workflowName}
            </span>
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
                    "border-border bg-muted text-muted-foreground grid size-[23px] shrink-0 place-items-center rounded-full border text-[9px]",
                    phase.status === "running" &&
                      "border-ring bg-secondary text-accent-foreground",
                    phase.status === "done" &&
                      "text-success bg-[color-mix(in_srgb,var(--success)_10%,transparent)]",
                  )}
                >
                  {index + 1}
                </span>
                <strong className="min-w-0 wrap-anywhere">{phase.title}</strong>
                <RuntimeStatus status={phase.status} />
              </li>
            ))}
          </ol>
          {run.agents.map((agent) => (
            <div
              className="border-border flex min-w-0 flex-wrap items-center gap-2.5 border-b py-3 text-xs"
              key={agent.id}
            >
              <span className="min-w-0 flex-1 wrap-anywhere">
                {agent.label ?? `Agent ${agent.id}`}
              </span>
              <span className="text-muted-foreground ml-auto text-xs">
                {agent.tokenCount.toLocaleString()} tokens · {agent.toolCount}{" "}
                calls
              </span>
              <RuntimeStatus status={agent.status} />
              {run.status === "running" && agent.status === "running" ? (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  disabled={busy}
                  aria-label={`Stop workflow agent ${agent.label ?? agent.id}`}
                  onClick={() => {
                    control.mutate({
                      type: "workflow_stop_agent",
                      id: run.runId,
                      agentId: agent.id,
                    });
                  }}
                >
                  <SquareIcon />
                </Button>
              ) : null}
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
                Run logs
              </summary>
              <pre className="border-border bg-background mt-2.5 max-h-[260px] overflow-auto rounded-[7px] border p-3 font-mono text-[10px] leading-[1.7] wrap-anywhere whitespace-pre-wrap">
                {run.logs.join("\n")}
              </pre>
            </details>
          ) : null}
          {run.returnValue !== undefined ? (
            <details>
              <summary className="text-muted-foreground text-xs">
                Result
              </summary>
              <pre className="bg-muted mt-2 max-h-64 overflow-auto rounded-lg border p-3 text-xs wrap-anywhere whitespace-pre-wrap">
                {JSON.stringify(run.returnValue, null, 2)}
              </pre>
            </details>
          ) : null}
          {run.status === "running" ? (
            <Button
              className="self-start"
              size="sm"
              variant="destructive"
              disabled={busy}
              onClick={() => {
                control.mutate({ type: "workflow_stop", id: run.runId });
              }}
            >
              <SquareIcon /> Stop run
            </Button>
          ) : null}
          {run.status === "failed" || run.status === "killed" ? (
            <Button
              className="self-start"
              size="sm"
              variant="outline"
              disabled={disabled || busy}
              onClick={() => {
                control.mutate({
                  type: "workflow_run",
                  input: { resumeFromRunId: run.runId },
                });
              }}
            >
              <PlayIcon />
              Resume run
            </Button>
          ) : null}
        </section>
      ))}
    </div>
  );
}

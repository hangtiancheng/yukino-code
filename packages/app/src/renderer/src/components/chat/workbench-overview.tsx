import { RuntimeStatus } from "@renderer/components/chat/runtime-status";
import { Button } from "@renderer/components/ui/button";
import type { RuntimeSnapshot, WorkbenchPage } from "@shared/workspace-types";
import {
  ArrowUpRightIcon,
  BotIcon,
  BoxesIcon,
  ListChecksIcon,
  WorkflowIcon,
} from "lucide-react";

export function WorkbenchOverview({
  data,
  openPage,
}: {
  data: RuntimeSnapshot;
  openPage: (page: WorkbenchPage) => void;
}): React.JSX.Element {
  const completedTasks = data.tasks.filter(
    (task) => task.status === "completed",
  ).length;
  const activeAgents =
    data.subagents.filter((agent) => agent.status === "running").length +
    data.teammates.filter((agent) => agent.status === "running").length;
  const activeWorkflows = data.workflows.filter(
    (run) => run.status === "running",
  );
  const shortcuts = [
    {
      page: "tasks",
      title: "Tasks completed",
      value: `${completedTasks}/${data.tasks.length}`,
      icon: ListChecksIcon,
    },
    {
      page: "agents",
      title: "Active agents",
      value: activeAgents,
      icon: BotIcon,
    },
    {
      page: "workflows",
      title: "Running workflows",
      value: activeWorkflows.length,
      icon: WorkflowIcon,
    },
    {
      page: "mcp",
      title: "Connected MCP servers",
      value: data.mcpServers.length,
      icon: BoxesIcon,
    },
  ] as const;
  const nextTask =
    data.tasks.find((task) => task.status === "in_progress") ??
    data.tasks.find((task) => task.status === "pending");
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-2.5 @min-[590px]/workbench:grid-cols-4">
        {shortcuts.map(({ page, title, value, icon: Icon }) => (
          <button
            key={page}
            type="button"
            className="workbench-tile group flex min-w-0 flex-col items-start gap-2.5 rounded-xl border p-3 text-left"
            onClick={() => {
              openPage(page);
            }}
          >
            <span className="flex w-full items-center justify-between gap-2">
              <span className="bg-accent text-accent-foreground grid size-7 place-items-center rounded-lg">
                <Icon className="size-4" />
              </span>
              <ArrowUpRightIcon className="text-muted-foreground group-hover:text-accent-foreground size-3.5 shrink-0" />
            </span>
            <span className="text-foreground text-lg leading-none font-semibold tabular-nums">
              {value}
            </span>
            <span className="text-muted-foreground text-xs leading-tight">
              {title}
            </span>
          </button>
        ))}
      </div>
      <section className="bg-muted/40 flex flex-col gap-3 rounded-xl border p-4">
        <h3 className="text-sm font-semibold">Current work</h3>
        {data.goal || nextTask ? (
          <Button
            variant="ghost"
            className="bg-card h-auto min-h-10 justify-start gap-3 whitespace-normal"
            onClick={() => {
              openPage("tasks");
            }}
          >
            <ListChecksIcon className="text-accent-foreground" />
            <span className="min-w-0 flex-1 text-left wrap-anywhere">
              {data.goal?.objective ?? nextTask?.subject}
            </span>
            <RuntimeStatus status={data.goal?.status ?? nextTask!.status} />
          </Button>
        ) : null}
        {activeWorkflows.map((run) => (
          <Button
            variant="ghost"
            key={run.runId}
            className="bg-card h-auto min-h-10 justify-start gap-3 whitespace-normal"
            onClick={() => {
              openPage("workflows");
            }}
          >
            <WorkflowIcon className="text-accent-foreground" />
            <span className="min-w-0 flex-1 text-left wrap-anywhere">
              {run.workflowName}
            </span>
            <RuntimeStatus status={run.status} />
          </Button>
        ))}
        {!data.goal && !nextTask && !activeWorkflows.length ? (
          <p className="text-muted-foreground text-xs">
            No goals, tasks, or workflows are in progress.
          </p>
        ) : null}
      </section>
    </div>
  );
}

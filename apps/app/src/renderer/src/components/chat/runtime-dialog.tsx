import { RuntimeAgents } from "@renderer/components/chat/runtime-agents";
import { RuntimeCapabilities } from "@renderer/components/chat/runtime-capabilities";
import { RuntimeTasks } from "@renderer/components/chat/runtime-tasks";
import { RuntimeWorkflows } from "@renderer/components/chat/runtime-workflows";
import { Button } from "@renderer/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@renderer/components/ui/dialog";
import { ChoiceSelect } from "@renderer/components/ui/select";
import { Spinner } from "@renderer/components/ui/spinner";
import {
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from "@renderer/components/ui/tabs";
import type { RuntimeAction, RuntimeSnapshot } from "@shared/workspace-types";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  BotIcon,
  BoxesIcon,
  HistoryIcon,
  LayersIcon,
  ListChecksIcon,
  RefreshCwIcon,
  SparklesIcon,
  WorkflowIcon,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

const pages = [
  { id: "tasks", label: "Goals and tasks", icon: ListChecksIcon },
  { id: "agents", label: "Agents and collaboration", icon: BotIcon },
  { id: "workflows", label: "Workflows", icon: WorkflowIcon },
  { id: "capabilities", label: "Tools and skills", icon: SparklesIcon },
  { id: "context", label: "Context and environment", icon: LayersIcon },
  { id: "history", label: "Checkpoints", icon: HistoryIcon },
] as const;

export function RuntimeDialog({
  open,
  onOpenChange,
  streaming,
  dirty,
  data,
  error,
  refreshing,
  onRefresh,
  onPrompt,
}: {
  open: boolean;
  onOpenChange: (value: boolean) => void;
  streaming: boolean;
  dirty: boolean;
  data: RuntimeSnapshot | undefined;
  error: Error | null;
  refreshing: boolean;
  onRefresh: () => void;
  onPrompt: (value: string) => void;
}): React.JSX.Element {
  const client = useQueryClient();
  const [page, setPage] = useState<(typeof pages)[number]["id"]>("tasks");
  const [confirm, setConfirm] = useState<string | null>(null);
  const [mode, setMode] = useState<
    "code_only" | "conversation_only" | "code_and_conversation"
  >("code_only");
  const action = useMutation({
    mutationFn: (value: RuntimeAction) => window.api.runtimeAction(value),
    onSuccess: () => client.invalidateQueries({ queryKey: ["runtime"] }),
    onError: (cause) => toast.error(cause.message),
  });
  const rewind = useMutation({
    mutationFn: (id: string) => window.api.rewind(id, mode),
    onSuccess: () => {
      setConfirm(null);
      onRefresh();
      toast.success("Checkpoint restored");
    },
    onError: (cause) => toast.error(cause.message),
  });
  const prompt = (value: string): void => {
    onOpenChange(false);
    onPrompt(value);
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[min(700px,85vh)] flex-col gap-0 overflow-hidden p-0 shadow-[0_24px_100px_#100a2820] max-[700px]:h-[90vh] sm:max-w-4xl">
        <div className="border-border flex min-h-[65px] items-center gap-[11px] border-b px-5">
          <span className="bg-secondary text-accent-foreground grid size-[31px] place-items-center rounded-[9px]">
            <BoxesIcon className="size-[18px]" />
          </span>
          <DialogTitle>Agent workbench</DialogTitle>
          <span className="text-muted-foreground ml-0.5 flex items-center gap-[5px] text-[10px]">
            <span className="bg-success inline-block size-[5px] shrink-0 rounded-full" />
            Live
          </span>
          <Button
            variant="ghost"
            size="icon-sm"
            className="mr-8 ml-auto"
            aria-label="Refresh capabilities"
            onClick={onRefresh}
          >
            <RefreshCwIcon className={refreshing ? "animate-spin" : ""} />
          </Button>
        </div>
        <DialogDescription className="sr-only">
          Goals, tasks, agents, workflows, tools, skills, MCP, memory, and
          checkpoints
        </DialogDescription>
        <Tabs
          value={page}
          onValueChange={(value) => {
            setPage(value as typeof page);
          }}
          orientation="vertical"
          className="flex min-h-0 flex-1 flex-row gap-0 max-[700px]:flex-col"
        >
          <div className="border-border bg-background max-[700px]:border-border flex w-[176px] shrink-0 flex-col gap-[5px] border-r px-3 py-[17px] max-[700px]:w-full max-[700px]:flex-row max-[700px]:overflow-x-auto max-[700px]:border-r-0 max-[700px]:border-b max-[700px]:p-2">
            <TabsList
              aria-label="Agent capabilities"
              className="flex h-auto w-full flex-col items-stretch gap-[5px] bg-transparent p-0 max-[700px]:w-max max-[700px]:flex-row"
            >
              {pages.map((item) => (
                <TabsTrigger
                  key={item.id}
                  value={item.id}
                  className="text-muted-foreground data-active:bg-accent data-active:text-accent-foreground h-10 flex-none justify-start gap-[9px] p-2.5 text-left text-xs after:hidden data-active:shadow-none! max-[700px]:p-2 max-[700px]:text-[10px]"
                >
                  <item.icon />
                  {item.label}
                </TabsTrigger>
              ))}
            </TabsList>
            {data ? (
              <div className="text-muted-foreground mt-auto flex flex-col gap-[5px] px-2.5 pt-4 pb-[3px] text-[10px] max-[700px]:hidden">
                <span>{data.tools.length} tools</span>
                <span>
                  {data.skills.length} skills · {data.mcpServers.length} MCP
                  servers
                </span>
              </div>
            ) : null}
          </div>
          <TabsContent
            value={page}
            className="bg-card min-w-0 flex-1 overflow-y-auto p-6 max-[700px]:p-[18px]"
          >
            {error ? (
              <div
                role="alert"
                className="text-destructive mb-[15px] flex items-center gap-2.5 rounded-[7px] bg-[color-mix(in_srgb,var(--destructive)_8%,var(--card))] p-3 text-[11px] [&>p]:flex-1"
              >
                <p>{error.message}</p>
                <Button size="sm" variant="outline" onClick={onRefresh}>
                  Retry
                </Button>
              </div>
            ) : null}
            {!data ? (
              !error ? (
                <div className="flex h-full flex-col items-center justify-center gap-3 p-5 text-center text-xs">
                  <Spinner />
                </div>
              ) : null
            ) : (
              <>
                {page === "tasks" ? (
                  <RuntimeTasks
                    data={data}
                    streaming={streaming}
                    busy={action.isPending}
                    onAction={action.mutate}
                    onPrompt={prompt}
                  />
                ) : null}
                {page === "agents" ? (
                  <RuntimeAgents
                    data={data}
                    busy={action.isPending}
                    onAction={action.mutate}
                  />
                ) : null}
                {page === "workflows" ? (
                  <RuntimeWorkflows
                    data={data}
                    disabled={streaming}
                    onPrompt={prompt}
                  />
                ) : null}
                {page === "capabilities" || page === "context" ? (
                  <RuntimeCapabilities
                    data={data}
                    page={page}
                    disabled={streaming}
                    busy={action.isPending}
                    onAction={action.mutate}
                    onPrompt={prompt}
                  />
                ) : null}
                {page === "history" ? (
                  <section className="[&+&]:border-border flex min-w-0 flex-col gap-3 [&+&]:border-t [&+&]:pt-[22px]">
                    <h3 className="[&>svg]:text-accent-foreground mb-0.5 flex min-h-[25px] items-center gap-2 text-xs font-semibold [&>svg]:size-[15px] [&>svg]:shrink-0">
                      <HistoryIcon />
                      Checkpoints
                      <span className="bg-muted text-muted-foreground inline-flex rounded-[5px] px-1.5 py-0.5 text-[9px] font-normal tabular-nums">
                        {data.checkpoints.length}
                      </span>
                    </h3>
                    {dirty ? (
                      <p className="text-warning mb-3 text-xs">
                        Save your drafts to restore checkpoints
                      </p>
                    ) : null}
                    {data.checkpoints.length ? (
                      [...data.checkpoints].reverse().map((checkpoint) => (
                        <div
                          className="border-border flex items-center gap-2.5 border-b py-[13px] text-xs"
                          key={checkpoint.id}
                        >
                          <HistoryIcon className="text-muted-foreground size-4 shrink-0" />
                          <div className="min-w-0 flex-1">
                            <p className="truncate font-medium">
                              {checkpoint.text || "Session checkpoint"}
                            </p>
                            <span className="text-muted-foreground text-xs">
                              {new Date(checkpoint.timestamp).toLocaleString()}{" "}
                              · {checkpoint.files} files
                            </span>
                          </div>
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={streaming || dirty || rewind.isPending}
                            onClick={() => {
                              setConfirm(checkpoint.id);
                            }}
                          >
                            Restore
                          </Button>
                        </div>
                      ))
                    ) : (
                      <div className="border-border text-muted-foreground flex flex-col items-center justify-center gap-3 rounded-[10px] border border-dashed p-9 text-[11px] [&>svg]:size-[27px] [&>svg]:opacity-45">
                        <HistoryIcon />
                        <span>No checkpoints yet</span>
                      </div>
                    )}
                    {confirm ? (
                      <div className="flex flex-col gap-3 rounded-[9px] border border-[color-mix(in_srgb,var(--warning)_35%,var(--border))] bg-[color-mix(in_srgb,var(--warning)_5%,var(--card))] p-[15px]">
                        <strong className="text-warning text-[11px] font-medium">
                          Restoring overwrites later changes
                        </strong>
                        <ChoiceSelect
                          label="Restore scope"
                          value={mode}
                          disabled={rewind.isPending}
                          onValueChange={setMode}
                          options={[
                            { value: "code_only", label: "Files only" },
                            {
                              value: "conversation_only",
                              label: "Conversation only",
                            },
                            {
                              value: "code_and_conversation",
                              label: "Files and conversation",
                            },
                          ]}
                        />
                        <div className="flex justify-end gap-2">
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={rewind.isPending}
                            onClick={() => {
                              setConfirm(null);
                            }}
                          >
                            Cancel
                          </Button>
                          <Button
                            size="sm"
                            variant="destructive"
                            disabled={streaming || dirty || rewind.isPending}
                            onClick={() => {
                              rewind.mutate(confirm);
                            }}
                          >
                            {rewind.isPending ? <Spinner /> : null}Confirm
                            restore
                          </Button>
                        </div>
                      </div>
                    ) : null}
                  </section>
                ) : null}
              </>
            )}
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

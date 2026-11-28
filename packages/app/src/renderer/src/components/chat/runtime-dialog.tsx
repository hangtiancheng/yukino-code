import { AgentConsole } from "@renderer/components/chat/agent-console";
import { RuntimeAgents } from "@renderer/components/chat/runtime-agents";
import { RuntimeCapabilities } from "@renderer/components/chat/runtime-capabilities";
import { RuntimeTasks } from "@renderer/components/chat/runtime-tasks";
import { RuntimeWorkflows } from "@renderer/components/chat/runtime-workflows";
import { WorkbenchOverview } from "@renderer/components/chat/workbench-overview";
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
import { workbenchPages } from "@renderer/lib/workbench-pages";
import type {
  RuntimeAction,
  RuntimeSnapshot,
  WorkbenchPage,
} from "@shared/workspace-types";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { BoxesIcon, HistoryIcon, RefreshCwIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

export function RuntimeDialog({
  open,
  onOpenChange,
  page,
  onPageChange,
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
  page: WorkbenchPage;
  onPageChange: (value: WorkbenchPage) => void;
  streaming: boolean;
  dirty: boolean;
  data: RuntimeSnapshot | undefined;
  error: Error | null;
  refreshing: boolean;
  onRefresh: () => void;
  onPrompt: (value: string) => void;
}): React.JSX.Element {
  const client = useQueryClient();
  const currentPage = workbenchPages.find((item) => item.id === page)!;
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
      <DialogContent className="flex h-[min(720px,calc(100dvh-48px))] flex-col gap-0 overflow-hidden p-0 sm:max-w-[960px]">
        <div className="workspace-toolbar flex min-h-16 shrink-0 items-center gap-3 border-b px-5 max-[700px]:px-4">
          <span className="bg-accent text-accent-foreground border-primary/15 grid size-9 shrink-0 place-items-center rounded-xl border">
            <BoxesIcon className="size-[18px]" />
          </span>
          <DialogTitle className="min-w-0 truncate pr-0">
            Agent workbench
          </DialogTitle>
          <Button
            variant="ghost"
            size="icon-sm"
            className="mr-7 ml-auto"
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
            onPageChange(value as WorkbenchPage);
          }}
          orientation="vertical"
          className="flex min-h-0 min-w-0 flex-1 flex-row gap-0"
        >
          <div className="border-border bg-sidebar flex w-48 shrink-0 flex-col gap-1 overflow-y-auto border-r px-3 py-4 max-[700px]:w-14 max-[700px]:px-2">
            <TabsList
              aria-label="Agent capabilities"
              className="flex h-auto w-full flex-col items-stretch gap-1 bg-transparent p-0"
            >
              {workbenchPages.map((item) => (
                <TabsTrigger
                  key={item.id}
                  value={item.id}
                  aria-label={item.label}
                  title={item.label}
                  className="text-muted-foreground hover:bg-card data-active:bg-accent data-active:text-accent-foreground h-9 min-w-0 flex-none justify-start gap-2.5 px-3 text-left text-xs after:hidden data-active:shadow-none! max-[700px]:justify-center! max-[700px]:px-0"
                >
                  <item.icon />
                  <span className="truncate max-[700px]:hidden">
                    {item.label}
                  </span>
                </TabsTrigger>
              ))}
            </TabsList>
          </div>
          <TabsContent
            key={page}
            value={page}
            className="bg-card @container/workbench min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain p-6 wrap-anywhere max-[700px]:p-4"
          >
            <h2 className="mb-5 text-xl font-semibold tracking-tight">
              {currentPage.label}
            </h2>
            {error ? (
              <div
                role="alert"
                className="text-destructive bg-destructive/8 mb-4 flex flex-wrap items-center gap-2.5 rounded-lg p-3 text-xs [&>p]:min-w-0 [&>p]:flex-1"
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
                {page === "overview" ? (
                  <WorkbenchOverview data={data} openPage={onPageChange} />
                ) : null}
                {page === "session" || page === "controls" || page === "mcp" ? (
                  <AgentConsole
                    page={page}
                    streaming={streaming}
                    dirty={dirty}
                  />
                ) : null}
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
                  <RuntimeWorkflows data={data} disabled={streaming} />
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
                          className="border-border flex flex-wrap items-center gap-2.5 border-b py-3 text-xs"
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
                          className="w-full"
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

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
  { id: "tasks", label: "目标与任务", icon: ListChecksIcon },
  { id: "agents", label: "Agent 与协作", icon: BotIcon },
  { id: "workflows", label: "工作流", icon: WorkflowIcon },
  { id: "capabilities", label: "工具与技能", icon: SparklesIcon },
  { id: "context", label: "上下文与环境", icon: LayersIcon },
  { id: "history", label: "检查点", icon: HistoryIcon },
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
      toast.success("检查点已恢复");
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
          <DialogTitle>Agent 工作台</DialogTitle>
          <span className="text-muted-foreground ml-0.5 flex items-center gap-[5px] text-[10px]">
            <span className="bg-success inline-block size-[5px] shrink-0 rounded-full" />
            实时
          </span>
          <Button
            variant="ghost"
            size="icon-sm"
            className="mr-8 ml-auto"
            aria-label="刷新能力"
            onClick={onRefresh}
          >
            <RefreshCwIcon className={refreshing ? "animate-spin" : ""} />
          </Button>
        </div>
        <DialogDescription className="sr-only">
          目标、任务、Agent、工作流、工具、技能、MCP、记忆与检查点
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
              aria-label="Agent 能力"
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
                <span>{data.tools.length} 个工具</span>
                <span>
                  {data.skills.length} 项技能 · {data.mcpServers.length} 个 MCP
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
                  重试
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
                      检查点
                      <span className="bg-muted text-muted-foreground inline-flex rounded-[5px] px-1.5 py-0.5 text-[9px] font-normal tabular-nums">
                        {data.checkpoints.length}
                      </span>
                    </h3>
                    {dirty ? (
                      <p className="text-warning mb-3 text-xs">
                        保存草稿后可恢复检查点
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
                              {checkpoint.text || "会话检查点"}
                            </p>
                            <span className="text-muted-foreground text-xs">
                              {new Date(checkpoint.timestamp).toLocaleString()}{" "}
                              · {checkpoint.files} 个文件
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
                            恢复
                          </Button>
                        </div>
                      ))
                    ) : (
                      <div className="border-border text-muted-foreground flex flex-col items-center justify-center gap-3 rounded-[10px] border border-dashed p-9 text-[11px] [&>svg]:size-[27px] [&>svg]:opacity-45">
                        <HistoryIcon />
                        <span>暂无检查点</span>
                      </div>
                    )}
                    {confirm ? (
                      <div className="flex flex-col gap-3 rounded-[9px] border border-[color-mix(in_srgb,var(--warning)_35%,var(--border))] bg-[color-mix(in_srgb,var(--warning)_5%,var(--card))] p-[15px]">
                        <strong className="text-warning text-[11px] font-medium">
                          恢复会覆盖后续修改
                        </strong>
                        <ChoiceSelect
                          label="恢复范围"
                          value={mode}
                          disabled={rewind.isPending}
                          onValueChange={setMode}
                          options={[
                            { value: "code_only", label: "仅恢复文件" },
                            { value: "conversation_only", label: "仅恢复对话" },
                            {
                              value: "code_and_conversation",
                              label: "恢复文件与对话",
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
                            取消
                          </Button>
                          <Button
                            size="sm"
                            variant="destructive"
                            disabled={streaming || dirty || rewind.isPending}
                            onClick={() => {
                              rewind.mutate(confirm);
                            }}
                          >
                            {rewind.isPending ? <Spinner /> : null}确认恢复
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

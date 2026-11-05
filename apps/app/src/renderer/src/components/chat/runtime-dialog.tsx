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
import { Spinner } from "@renderer/components/ui/spinner";
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
      <DialogContent className="runtime-dialog p-0 sm:max-w-4xl">
        <div className="runtime-titlebar">
          <span className="runtime-logo">
            <BoxesIcon />
          </span>
          <DialogTitle>Agent 工作台</DialogTitle>
          <span className="runtime-live">
            <span className="status-dot" />
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
        <div className="runtime-layout">
          <nav className="runtime-nav" aria-label="Agent 能力">
            {pages.map((item) => (
              <button
                key={item.id}
                aria-current={page === item.id ? "page" : undefined}
                className={page === item.id ? "active" : ""}
                onClick={() => {
                  setPage(item.id);
                }}
              >
                <item.icon />
                {item.label}
              </button>
            ))}
            {data ? (
              <div className="runtime-nav-meta">
                <span>{data.tools.length} 个工具</span>
                <span>
                  {data.skills.length} 项技能 · {data.mcpServers.length} 个 MCP
                </span>
              </div>
            ) : null}
          </nav>
          <div className="runtime-content">
            {error ? (
              <div role="alert" className="runtime-error">
                <p>{error.message}</p>
                <Button size="sm" variant="outline" onClick={onRefresh}>
                  重试
                </Button>
              </div>
            ) : null}
            {!data ? (
              !error ? (
                <div className="panel-empty">
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
                  <section className="runtime-section">
                    <h3 className="runtime-heading">
                      <HistoryIcon />
                      检查点
                      <span className="runtime-count">
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
                        <div className="checkpoint-row" key={checkpoint.id}>
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
                      <div className="runtime-empty-state">
                        <HistoryIcon />
                        <span>暂无检查点</span>
                      </div>
                    )}
                    {confirm ? (
                      <div className="rewind-confirm">
                        <strong>恢复会覆盖后续修改</strong>
                        <select
                          aria-label="恢复范围"
                          className="native-select"
                          value={mode}
                          disabled={rewind.isPending}
                          onChange={(event) => {
                            setMode(event.target.value as typeof mode);
                          }}
                        >
                          <option value="code_only">仅恢复文件</option>
                          <option value="conversation_only">仅恢复对话</option>
                          <option value="code_and_conversation">
                            恢复文件与对话
                          </option>
                        </select>
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
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

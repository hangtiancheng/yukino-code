import { Button } from "@renderer/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@renderer/components/ui/dialog";
import { Spinner } from "@renderer/components/ui/spinner";
import type { RuntimeSnapshot } from "@shared/workspace-types";
import {
  BoxesIcon,
  CheckCircle2Icon,
  CircleIcon,
  HistoryIcon,
  ListChecksIcon,
  RefreshCwIcon,
  WrenchIcon,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

export function RuntimeDialog({
  open,
  onOpenChange,
  streaming,
}: {
  open: boolean;
  onOpenChange: (value: boolean) => void;
  streaming: boolean;
}): React.JSX.Element {
  const [data, setData] = useState<RuntimeSnapshot | null>(null);
  const [error, setError] = useState("");
  const [page, setPage] = useState<"tasks" | "capabilities" | "history">(
    "tasks",
  );
  const [confirm, setConfirm] = useState<string | null>(null);
  const [mode, setMode] = useState<
    "code_only" | "conversation_only" | "code_and_conversation"
  >("code_only");
  const [busy, setBusy] = useState(false);
  const refresh = useCallback(() => {
    void window.api
      .getRuntime()
      .then((value) => {
        setData(value);
        setError("");
      })
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : String(cause));
      });
  }, []);
  useEffect(() => {
    if (!open) {
      return;
    }
    refresh();
    const timer = setInterval(refresh, 2000);
    return () => {
      clearInterval(timer);
    };
  }, [open, refresh]);
  const run = (command: string): void => {
    onOpenChange(false);
    void window.api
      .runCommand(command)
      .catch((cause: unknown) => toast.error(String(cause)));
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[80vh] flex-col sm:max-w-2xl">
        <DialogTitle>Agent 工作台</DialogTitle>
        <DialogDescription className="sr-only">
          任务、能力与检查点
        </DialogDescription>
        <div className="runtime-tabs">
          {(
            [
              { id: "tasks", label: "任务与协作", icon: ListChecksIcon },
              { id: "capabilities", label: "能力与上下文", icon: BoxesIcon },
              { id: "history", label: "检查点", icon: HistoryIcon },
            ] as const
          ).map((item) => (
            <button
              key={item.id}
              className={page === item.id ? "active" : ""}
              onClick={() => {
                setPage(item.id);
              }}
            >
              <item.icon className="size-4" />
              {item.label}
            </button>
          ))}
          <Button
            variant="ghost"
            size="icon-sm"
            className="ml-auto"
            onClick={refresh}
            aria-label="刷新能力"
          >
            <RefreshCwIcon />
          </Button>
        </div>
        {error ? (
          <p role="alert" className="text-destructive text-sm">
            {error}
          </p>
        ) : !data ? (
          <Spinner />
        ) : (
          <div className="min-h-0 overflow-auto pr-1">
            {page === "tasks" ? (
              <div className="space-y-5">
                <div>
                  <h3 className="runtime-heading">任务清单</h3>
                  {data.tasks.length ? (
                    data.tasks.map((task) => (
                      <div key={task.id} className="runtime-row">
                        {task.status === "completed" ? (
                          <CheckCircle2Icon className="text-success size-4" />
                        ) : (
                          <CircleIcon className="text-primary size-4" />
                        )}
                        <span>{task.subject}</span>
                        <span className="text-muted-foreground ml-auto text-xs">
                          {task.status}
                        </span>
                      </div>
                    ))
                  ) : (
                    <p className="runtime-empty">暂无任务</p>
                  )}
                </div>
                <div>
                  <h3 className="runtime-heading">后台任务与团队</h3>
                  {[
                    ...data.backgroundTasks.map((task) => ({
                      key: task.id,
                      name: task.name,
                      status: task.status,
                    })),
                    ...data.teammates.map((member) => ({
                      key: member.name,
                      name: member.name,
                      status: member.status,
                    })),
                  ].map((item) => (
                    <div key={item.key} className="runtime-row">
                      <span>{item.name}</span>
                      <span className="text-muted-foreground ml-auto text-xs">
                        {item.status}
                      </span>
                    </div>
                  ))}
                  {!data.backgroundTasks.length && !data.teammates.length ? (
                    <p className="runtime-empty">暂无后台任务</p>
                  ) : null}
                </div>
              </div>
            ) : page === "capabilities" ? (
              <div className="space-y-5">
                <div>
                  <h3 className="runtime-heading">
                    <WrenchIcon className="size-4" />
                    工具 · {data.tools.length}
                  </h3>
                  <div className="flex flex-wrap gap-1.5">
                    {data.tools.map((tool) => (
                      <span key={tool} className="capability-chip">
                        {tool}
                      </span>
                    ))}
                  </div>
                </div>
                <div>
                  <h3 className="runtime-heading">
                    Skills · {data.skills.length}
                  </h3>
                  {data.skills.map((skill) => (
                    <button
                      key={skill.name}
                      className="runtime-skill"
                      disabled={streaming}
                      onClick={() => {
                        run(`/${skill.name}`);
                      }}
                    >
                      <strong>/{skill.name}</strong>
                      <span>{skill.description}</span>
                    </button>
                  ))}
                  {!data.skills.length ? (
                    <p className="runtime-empty">
                      将 SKILL.md 放入项目的 .agents/skills
                      或全局技能目录，然后使用 /skills reload。
                    </p>
                  ) : null}
                </div>
                <div>
                  <h3 className="runtime-heading">
                    MCP · {data.mcpServers.length}
                  </h3>
                  {data.mcpServers.length ? (
                    data.mcpServers.map((name) => (
                      <div key={name} className="runtime-row">
                        <span className="status-dot" />
                        {name}
                      </div>
                    ))
                  ) : (
                    <p className="runtime-empty">未连接 MCP</p>
                  )}
                </div>
                <div>
                  <h3 className="runtime-heading">
                    记忆 · {data.memories.length}
                  </h3>
                  {data.memories.map((memory) => (
                    <div className="runtime-row" key={memory.name}>
                      <strong>{memory.name}</strong>
                      <span className="text-muted-foreground text-xs">
                        {memory.description}
                      </span>
                    </div>
                  ))}
                </div>
                <Button
                  variant="outline"
                  disabled={streaming}
                  onClick={() => {
                    run("/workflows");
                  }}
                >
                  管理工作流
                </Button>
              </div>
            ) : (
              <div>
                <p className="text-muted-foreground mb-3 text-xs leading-6">
                  恢复会覆盖后续修改。
                </p>
                {data.checkpoints.length ? (
                  [...data.checkpoints].reverse().map((checkpoint) => (
                    <div key={checkpoint.id} className="checkpoint-row">
                      <HistoryIcon className="text-muted-foreground size-4 shrink-0" />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm">
                          {checkpoint.text || "会话检查点"}
                        </p>
                        <span className="text-muted-foreground text-xs">
                          {new Date(checkpoint.timestamp).toLocaleString()} ·{" "}
                          {checkpoint.files} 个文件
                        </span>
                      </div>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={streaming || busy}
                        onClick={() => {
                          setConfirm(checkpoint.id);
                        }}
                      >
                        恢复
                      </Button>
                    </div>
                  ))
                ) : (
                  <p className="runtime-empty">暂无检查点</p>
                )}
                {confirm ? (
                  <div className="border-warning/40 bg-warning/5 mt-3 rounded-lg border p-3">
                    <p className="mb-2 text-sm font-medium">选择恢复范围</p>
                    <select
                      className="native-select w-full"
                      value={mode}
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
                    <div className="mt-3 flex justify-end gap-2">
                      <Button
                        variant="ghost"
                        onClick={() => {
                          setConfirm(null);
                        }}
                      >
                        取消
                      </Button>
                      <Button
                        variant="destructive"
                        disabled={busy || streaming}
                        onClick={() => {
                          setBusy(true);
                          void window.api
                            .rewind(confirm, mode)
                            .then(() => {
                              setConfirm(null);
                              refresh();
                              toast.success("检查点已恢复");
                            })
                            .catch((cause: unknown) =>
                              toast.error(String(cause)),
                            )
                            .finally(() => {
                              setBusy(false);
                            });
                        }}
                      >
                        确认恢复
                      </Button>
                    </div>
                  </div>
                ) : null}
              </div>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

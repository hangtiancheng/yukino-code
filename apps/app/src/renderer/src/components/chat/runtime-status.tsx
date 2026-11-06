import { cn } from "cn";
import {
  CheckIcon,
  CircleIcon,
  LoaderCircleIcon,
  PauseIcon,
  XIcon,
} from "lucide-react";

const labels: Record<string, string> = {
  pending: "待处理",
  in_progress: "进行中",
  running: "运行中",
  active: "进行中",
  completed: "已完成",
  complete: "已完成",
  done: "已完成",
  failed: "失败",
  blocked: "受阻",
  idle: "空闲",
  stopped: "已停止",
  cancelled: "已取消",
  killed: "已停止",
  paused: "已暂停",
  budget_limited: "预算已用尽",
  max_turns: "达到轮次上限",
};

export function RuntimeStatus({
  status,
  className,
}: {
  status: string;
  className?: string;
}): React.JSX.Element {
  const active = ["active", "running", "in_progress"].includes(status);
  const done = ["completed", "complete", "done"].includes(status);
  const failed = ["failed", "blocked", "budget_limited"].includes(status);
  const Icon = active
    ? LoaderCircleIcon
    : done
      ? CheckIcon
      : failed
        ? XIcon
        : status === "paused"
          ? PauseIcon
          : CircleIcon;
  return (
    <span
      className={cn(
        "bg-muted text-muted-foreground inline-flex shrink-0 items-center gap-1 rounded-[5px] px-1.5 py-[3px] text-[9px] font-normal whitespace-nowrap [&>svg]:size-2.5",
        active && "bg-secondary text-accent-foreground",
        done &&
          "text-success bg-[color-mix(in_srgb,var(--success)_10%,transparent)]",
        failed &&
          "text-destructive bg-[color-mix(in_srgb,var(--destructive)_10%,transparent)]",
        className,
      )}
    >
      <Icon className={active ? "animate-spin" : ""} />
      {labels[status] ?? status}
    </span>
  );
}

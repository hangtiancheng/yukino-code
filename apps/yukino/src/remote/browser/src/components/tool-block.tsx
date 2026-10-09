import { argsPreview, formatArgs, truncateOutput } from "@browser/lib/format";
import type { ToolItem } from "@browser/types";

import { Collapsible } from "./collapsible";

interface ToolBlockProps {
  item: ToolItem;
}

/**
 * Status pill + panel wash, mirroring the TUI tool cards: a running card is
 * amber and pulses, success washes green, failure washes red.
 */
const STATUS_META: Record<
  ToolItem["status"],
  { label: string; pill: string; panel: string }
> = {
  running: {
    label: "running…",
    pill: "bg-yellow/15 text-yellow",
    panel: "border-yellow/35 bg-yellow/[0.06]",
  },
  ok: {
    label: "✓",
    pill: "bg-green/15 text-green",
    panel: "border-green/25 bg-green/[0.05]",
  },
  err: {
    label: "✗",
    pill: "bg-red/15 text-red",
    panel: "border-red/30 bg-red/[0.06]",
  },
};

export function ToolBlock({ item }: ToolBlockProps) {
  const meta = STATUS_META[item.status];
  const statusText =
    item.status === "running"
      ? meta.label
      : `${meta.label} ${item.elapsed.toFixed(1)}s`;
  const preview = argsPreview(item.args);
  const argsStr = formatArgs(item.args);
  const output = item.output ? truncateOutput(item.output) : "";

  return (
    <Collapsible
      className={meta.panel}
      header={
        <>
          <span className="font-mono font-semibold text-accent">
            {item.toolName}
          </span>
          {preview && (
            <span className="ml-0.5 max-w-105 overflow-hidden font-mono text-xs text-ellipsis whitespace-nowrap text-dim">
              {preview}
            </span>
          )}
          <span
            className={`ml-auto shrink-0 rounded-full px-2 py-0.5 font-mono text-[11px] tabular-nums ${meta.pill} ${item.status === "running" ? "animate-pulse" : ""}`}
          >
            {statusText}
          </span>
        </>
      }
    >
      {argsStr && (
        <div className="mb-2 text-accent/90">
          Args:{"\n"}
          {argsStr}
        </div>
      )}
      {output && <div className="text-dim">{output}</div>}
    </Collapsible>
  );
}

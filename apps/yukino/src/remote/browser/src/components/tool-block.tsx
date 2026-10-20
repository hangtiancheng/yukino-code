import { Collapsible } from "#/components/collapsible.js";
import { DiffLines } from "#/components/diff-lines.js";
import { argsPreview, formatArgs } from "#/lib/format.js";
import type { ToolItem } from "#/types.js";

interface ToolBlockProps {
  item: ToolItem;
}

const STATUS_META: Record<
  ToolItem["status"],
  { label: string; pill: string; panel: string }
> = {
  running: {
    label: "running…",
    pill: "text-muted",
    panel: "bg-tool",
  },
  ok: {
    label: "✓",
    pill: "text-green",
    panel: "bg-tool-ok",
  },
  err: {
    label: "✗",
    pill: "text-red",
    panel: "bg-tool-error",
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
  const output = item.output ?? "";
  const lines = output.trimEnd().split("\n");
  const shell = /^(bash|powershell)$/iu.test(item.toolName);
  const limit = shell ? 5 : 10;
  const previewText = (
    shell ? lines.slice(-limit) : lines.slice(0, limit)
  ).join("\n");
  const diff = /^(Write|Edit|WriteFile|EditFile|ApplyPatch)$/iu.test(
    item.toolName,
  );
  const previewOutput = diff ? <DiffLines text={previewText} /> : previewText;

  return (
    <Collapsible
      className={meta.panel}
      preview={
        output && (
          <>
            {previewOutput}
            {lines.length > limit && (
              <p className="mt-1 text-dim">
                … ({String(lines.length - limit)} more lines, click to expand)
              </p>
            )}
          </>
        )
      }
      header={
        <>
          <span className="shrink-0 font-semibold text-bright">
            {shell
              ? item.toolName.toLowerCase() === "bash"
                ? "$"
                : ">"
              : item.toolName}
          </span>
          {preview && (
            <span className="ml-0.5 max-w-105 overflow-hidden font-mono text-xs text-ellipsis whitespace-nowrap text-dim">
              {preview}
            </span>
          )}
          <span
            className={`ml-auto shrink-0 text-xs tabular-nums ${meta.pill}`}
          >
            {statusText}
          </span>
        </>
      }
    >
      {argsStr && (
        <div className="mb-2 text-muted">
          Args:{"\n"}
          {argsStr}
        </div>
      )}
      {output && (diff ? <DiffLines text={output} /> : <div>{output}</div>)}
    </Collapsible>
  );
}

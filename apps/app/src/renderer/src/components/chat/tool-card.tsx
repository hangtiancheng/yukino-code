// Renders a single tool invocation as a collapsible Trace row: an inline
// status line plus, when expanded, the arguments and output.

import { cn } from "cn";
import {
  CheckIcon,
  ChevronDownIcon,
  CircleDotIcon,
  FileTextIcon,
  WrenchIcon,
  XIcon,
} from "lucide-react";
import type { ChatItem } from "@renderer/lib/chat-state";
import { Spinner } from "@renderer/components/ui/spinner";
import {
  TraceIcon,
  TraceLine,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
} from "@renderer/components/ui/trace";
import { Badge } from "@renderer/components/ui/badge";

type ToolItem = Extract<ChatItem, { kind: "tool" }>;

/** A short, human summary of the tool call for the collapsed line. */
function toolSummary(name: string, args: Record<string, unknown>): string {
  const pick = (key: string): string => {
    const value = args[key];
    if (typeof value === "string" && value.length > 0) return value;
    return "";
  };
  switch (name) {
    case "Bash":
      return pick("command");
    case "Read":
    case "Edit":
    case "Write":
    case "NotebookEdit":
      return pick("file_path") || pick("notebook_path");
    case "Grep":
      return pick("pattern");
    case "Glob":
      return pick("pattern");
    case "WebFetch":
      return pick("url");
    case "Agent":
      return pick("description") || pick("subagent_type");
    default:
      return "";
  }
}

function formatJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function ToolCard({ item }: { item: ToolItem }): React.JSX.Element {
  const summary = toolSummary(item.toolName, item.args);
  const status = item.running ? "running" : item.isError ? "error" : undefined;

  return (
    <TraceCollapsible>
      <TraceCollapsibleTrigger className="group w-full max-w-full">
        <TraceLine status={status} className="w-full">
          <TraceIcon>
            {item.running ? (
              <Spinner />
            ) : item.isError ? (
              <XIcon className="text-destructive" />
            ) : (
              <CheckIcon />
            )}
          </TraceIcon>
          <span data-slot="trace-title" className="min-w-0 flex-1 truncate">
            {item.toolName}
            {summary ? (
              <span className="text-muted-foreground/80"> · {summary}</span>
            ) : null}
          </span>
          {typeof item.elapsed === "number" && item.elapsed > 0 ? (
            <span className="shrink-0 text-xs tabular-nums">
              {(item.elapsed / 1000).toFixed(1)}s
            </span>
          ) : null}
        </TraceLine>
        <ChevronDownIcon className="size-3.5 shrink-0 transition-transform group-aria-expanded:rotate-180" />
      </TraceCollapsibleTrigger>

      <TraceCollapsibleContent className="font-mono text-xs leading-relaxed">
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <span className="text-muted-foreground flex items-center gap-1.5 font-sans text-[11px] font-medium tracking-wide uppercase">
              <FileTextIcon className="size-3" /> Arguments
            </span>
            <pre className="bg-muted/60 max-h-52 overflow-auto rounded-md p-3 wrap-break-word whitespace-pre-wrap">
              {formatJson(item.args)}
            </pre>
          </div>
          {item.output !== null ? (
            <div className="flex flex-col gap-1">
              <span className="text-muted-foreground flex items-center gap-1.5 font-sans text-[11px] font-medium tracking-wide uppercase">
                {item.isError ? (
                  <XIcon className="text-destructive size-3" />
                ) : (
                  <CircleDotIcon className="size-3" />
                )}
                Output
                {item.isError ? (
                  <Badge variant="destructive" className="ml-auto">
                    error
                  </Badge>
                ) : null}
              </span>
              <pre
                className={cn(
                  "bg-muted/60 max-h-64 overflow-auto rounded-md p-3 wrap-break-word whitespace-pre-wrap",
                  item.isError && "text-destructive",
                )}
              >
                {item.output}
              </pre>
            </div>
          ) : (
            <div className="text-muted-foreground flex items-center gap-2">
              <WrenchIcon className="size-3.5" /> Running…
            </div>
          )}
        </div>
      </TraceCollapsibleContent>
    </TraceCollapsible>
  );
}

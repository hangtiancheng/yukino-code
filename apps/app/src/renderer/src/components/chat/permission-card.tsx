// Inline permission approval card. Mirrors the terminal HITL flow: shows the
// tool, its arguments, the reason the permission system flagged it, and three
// actions (allow once / allow always / deny).

import { useState } from "react";
import { cn } from "cn";
import { ShieldAlertIcon, ChevronDownIcon } from "lucide-react";
import type { PermissionResponse } from "@shared/ipc-types";
import type { ChatItem } from "@renderer/lib/chat-state";
import { Card, CardContent } from "@renderer/components/ui/card";
import { Button } from "@renderer/components/ui/button";
import { Badge } from "@renderer/components/ui/badge";
import { Separator } from "@renderer/components/ui/separator";

type PermissionItem = Extract<ChatItem, { kind: "permission" }>;

function formatArgs(args: Record<string, unknown>): string {
  try {
    return JSON.stringify(args, null, 2);
  } catch {
    return String(args);
  }
}

const responseLabel: Record<PermissionResponse, string> = {
  allow: "Allowed",
  allowAlways: "Always allowed",
  deny: "Denied",
};

export function PermissionCard({
  item,
  onRespond,
}: {
  item: PermissionItem;
  onRespond: (id: string, response: PermissionResponse) => void;
}): React.JSX.Element {
  const [showArgs, setShowArgs] = useState(false);
  const resolved = item.response !== null;
  const { payload } = item;

  return (
    <Card
      className={cn(
        "border-warning/30 bg-warning/5 w-full max-w-2xl gap-0 py-0",
        resolved && "opacity-70",
      )}
    >
      <CardContent className="flex flex-col gap-3 p-4">
        <div className="flex items-start gap-3">
          <span className="bg-warning/15 text-warning mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md">
            <ShieldAlertIcon className="size-4" />
          </span>
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium">{payload.toolName}</span>
              <Badge variant="secondary" className="text-[10px] uppercase">
                permission
              </Badge>
              {payload.source ? (
                <Badge
                  variant="outline"
                  className="ml-auto shrink-0 text-[10px]"
                >
                  {payload.source.agentName}
                </Badge>
              ) : null}
            </div>
            {payload.reason ? (
              <p className="text-muted-foreground text-xs leading-relaxed wrap-break-word">
                {payload.reason}
              </p>
            ) : null}
          </div>
        </div>

        <button
          type="button"
          onClick={() => setShowArgs((value) => !value)}
          className="text-muted-foreground hover:text-foreground flex w-fit items-center gap-1 text-xs transition-colors"
        >
          <ChevronDownIcon
            className={cn(
              "size-3.5 transition-transform",
              showArgs && "rotate-180",
            )}
          />
          {showArgs ? "Hide" : "Show"} arguments
        </button>

        {showArgs ? (
          <pre className="bg-muted/60 max-h-52 overflow-auto rounded-md p-3 font-mono text-xs wrap-break-word whitespace-pre-wrap">
            {formatArgs(payload.args)}
          </pre>
        ) : null}

        {payload.rememberPatterns?.length ? (
          <div className="flex flex-wrap gap-1">
            {payload.rememberPatterns.map((pattern) => (
              <Badge
                key={pattern}
                variant="outline"
                className="font-mono text-[10px]"
              >
                {pattern}
              </Badge>
            ))}
          </div>
        ) : null}

        <Separator />

        {item.response ? (
          <div
            className={cn(
              "text-xs font-medium",
              item.response === "deny"
                ? "text-destructive"
                : "text-muted-foreground",
            )}
          >
            {responseLabel[item.response]}
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" onClick={() => onRespond(payload.id, "allow")}>
              Allow
            </Button>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => onRespond(payload.id, "allowAlways")}
            >
              Always allow
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="text-destructive hover:text-destructive ml-auto"
              onClick={() => onRespond(payload.id, "deny")}
            >
              Deny
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

import { Markdown } from "@renderer/components/chat/markdown";
import { Button } from "@renderer/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@renderer/components/ui/dialog";
import { Textarea } from "@renderer/components/ui/textarea";
import { useEffect, useState } from "react";
import { toast } from "sonner";

export function PlanDialog(): React.JSX.Element {
  const [plan, setPlan] = useState<{
    id: string;
    content: string;
    path: string;
  } | null>(null);
  const [feedback, setFeedback] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(
    () =>
      window.api.onEvent((event) => {
        if (event.type === "plan_approval") {
          setPlan(event.data);
          setFeedback("");
          setBusy(false);
        }
      }),
    [],
  );
  const respond = (choice: "approve" | "feedback"): void => {
    if (!plan) {
      return;
    }
    setBusy(true);
    void window.api
      .respondPlan(plan.id, choice, feedback)
      .catch((error: unknown) => toast.error(String(error)))
      .finally(() => {
        setBusy(false);
      });
  };
  return (
    <Dialog open={plan !== null}>
      <DialogContent
        className="flex max-h-[85vh] flex-col sm:max-w-2xl"
        showCloseButton={false}
      >
        <DialogTitle>执行计划</DialogTitle>
        <DialogDescription>执行时仍需工具授权。</DialogDescription>
        <div className="min-h-0 overflow-auto rounded-lg border p-4">
          {plan ? <Markdown text={plan.content} /> : null}
        </div>
        <Textarea
          value={feedback}
          onChange={(event) => {
            setFeedback(event.target.value);
          }}
          placeholder="修改意见"
          aria-label="计划修改意见"
        />
        <div className="flex justify-end gap-2">
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() => {
              void window.api
                .abort()
                .catch((error: unknown) => toast.error(String(error)));
            }}
          >
            暂不执行
          </Button>
          <Button
            variant="outline"
            disabled={busy || !feedback.trim()}
            onClick={() => {
              respond("feedback");
            }}
          >
            修改计划
          </Button>
          <Button
            disabled={busy}
            onClick={() => {
              respond("approve");
            }}
          >
            批准并执行
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

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
        <DialogTitle>Execute plan</DialogTitle>
        <DialogDescription>
          Tool permissions are still required during execution.
        </DialogDescription>
        <div className="min-h-0 overflow-auto rounded-lg border p-4">
          {plan ? <Markdown text={plan.content} /> : null}
        </div>
        <Textarea
          value={feedback}
          onChange={(event) => {
            setFeedback(event.target.value);
          }}
          placeholder="Feedback"
          aria-label="Plan feedback"
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
            Cancel execution
          </Button>
          <Button
            variant="outline"
            disabled={busy || !feedback.trim()}
            onClick={() => {
              respond("feedback");
            }}
          >
            Revise plan
          </Button>
          <Button
            disabled={busy}
            onClick={() => {
              respond("approve");
            }}
          >
            Approve and run
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

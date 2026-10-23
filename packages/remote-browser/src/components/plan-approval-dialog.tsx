import { useState } from "react";

import { Markdown } from "#/components/markdown.js";
import { Modal, ModalHeader } from "#/components/modal.js";
import type { PlanApprovalPayload, PlanChoice } from "#/types.js";

interface PlanApprovalDialogProps {
  request: PlanApprovalPayload;
  onChoose: (choice: PlanChoice, feedback?: string) => void;
}

/**
 * Plan approval gate (parity with the terminal PlanApprovalDialog): approve
 * with YOLO auto-approval, approve with per-edit confirmations, or send
 * feedback to keep planning. Escape approves with manual confirmations.
 */
export function PlanApprovalDialog({
  request,
  onChoose,
}: PlanApprovalDialogProps) {
  const [feedback, setFeedback] = useState("");
  const [feedbackOpen, setFeedbackOpen] = useState(false);

  return (
    <Modal
      label="Plan approval"
      maxWidth="max-w-2xl"
      onEscape={() => {
        onChoose("manual");
      }}
    >
      <ModalHeader
        subtitle="Yukino has written a plan and is ready to execute."
        title="Plan complete"
      />

      <div className="min-h-0 flex-1 overflow-y-auto px-4 sm:px-5 py-4">
        <p
          className="mb-3 truncate font-mono text-[11px] text-dim"
          title={request.planPath}
        >
          {request.planPath}
        </p>
        {request.planContent ? (
          <Markdown text={request.planContent} />
        ) : (
          <p className="text-sm text-dim">The plan file is empty.</p>
        )}
      </div>

      <div className="border-t border-border px-4 sm:px-5 py-4">
        {feedbackOpen && (
          <div className="mb-3">
            <textarea
              value={feedback}
              autoFocus
              onChange={(e) => {
                setFeedback(e.target.value);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && feedback.trim()) {
                  e.preventDefault();
                  e.stopPropagation();
                  onChoose("feedback", feedback.trim());
                }
              }}
              placeholder="Tell Yukino what to change..."
              aria-label="Feedback"
              rows={3}
              className="w-full resize-none rounded-none border border-border bg-bg px-3 py-2 text-sm text-bright outline-none placeholder:text-dim focus:border-accent"
            />
          </div>
        )}
        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
          <button
            type="button"
            onClick={() => {
              onChoose("manual");
            }}
            className="w-full cursor-pointer rounded-none sm:w-auto bg-accent px-4 py-2 text-[13px] sm:py-1.5 font-semibold text-accent-contrast  transition-colors hover:bg-accent-dim"
          >
            Yes, manually approve edits
          </button>
          <button
            type="button"
            onClick={() => {
              onChoose("yolo");
            }}
            className="w-full cursor-pointer rounded-none sm:w-auto border border-yellow/40 px-4 py-2 text-[13px] sm:py-1.5 font-semibold text-yellow transition-colors hover:bg-yellow/8"
          >
            Yes, enter YOLO mode (auto-approve all)
          </button>
          <button
            type="button"
            onClick={() => {
              if (feedbackOpen) {
                if (feedback.trim()) {
                  onChoose("feedback", feedback.trim());
                }
              } else {
                setFeedbackOpen(true);
              }
            }}
            className="w-full cursor-pointer rounded-none sm:w-auto border border-border px-4 py-2 text-[13px] sm:py-1.5 font-semibold text-base transition-colors hover:bg-bg"
          >
            {feedbackOpen ? "Send feedback" : "Tell Yukino what to change"}
          </button>
        </div>
        <p className="mt-2.5 text-[11px] text-dim">
          Esc approves with manual edit confirmations.
        </p>
      </div>
    </Modal>
  );
}

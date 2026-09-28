/**
 * Copyright (c) 2026 hangtiancheng
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

import { renderMarkdown } from "@fe/lib/markdown";
import type { PlanApprovalPayload, PlanChoice } from "@fe/types";
import { useState } from "react";

import { Modal, ModalHeader } from "./modal";

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
  const planHtml = request.planContent
    ? renderMarkdown(request.planContent)
    : "";

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

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        <p
          className="mb-3 truncate font-mono text-[11px] text-dim"
          title={request.planPath}
        >
          {request.planPath}
        </p>
        {planHtml ? (
          <div
            className="text-sm leading-relaxed [&_a]:text-accent [&_a]:underline [&_a]:underline-offset-2 [&_code]:rounded [&_code]:bg-code [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[13px] [&_h1]:mt-4 [&_h1]:mb-2 [&_h1]:text-base [&_h1]:font-semibold [&_h2]:mt-4 [&_h2]:mb-2 [&_h2]:font-semibold [&_h2]:text-bright [&_h3]:mt-3 [&_h3]:mb-1.5 [&_h3]:font-semibold [&_h3]:text-bright [&_li]:my-1 [&_ol]:my-2 [&_ol]:pl-5 [&_p]:mb-2 [&_pre]:my-2.5 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:border [&_pre]:border-border [&_pre]:bg-code [&_pre]:p-3.5 [&_pre_code]:bg-none [&_pre_code]:p-0 [&_ul]:my-2 [&_ul]:pl-5"
            dangerouslySetInnerHTML={{ __html: planHtml }}
          />
        ) : (
          <p className="text-sm text-dim">The plan file is empty.</p>
        )}
      </div>

      <div className="border-t border-border px-5 py-4">
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
              className="w-full resize-none rounded-lg border border-border bg-bg px-3 py-2 text-sm text-bright outline-none placeholder:text-dim/70 focus:border-accent"
            />
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => {
              onChoose("manual");
            }}
            className="cursor-pointer rounded-lg bg-accent px-4 py-1.5 text-[13px] font-semibold text-white shadow-xs transition-colors hover:bg-accent-dim"
          >
            Yes, manually approve edits
          </button>
          <button
            type="button"
            onClick={() => {
              onChoose("yolo");
            }}
            className="cursor-pointer rounded-lg border border-yellow/40 px-4 py-1.5 text-[13px] font-semibold text-yellow transition-colors hover:bg-yellow/8"
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
            className="cursor-pointer rounded-lg border border-border px-4 py-1.5 text-[13px] font-semibold text-base transition-colors hover:bg-bg"
          >
            {feedbackOpen ? "Send feedback" : "Tell Yukino what to change"}
          </button>
        </div>
        <p className="mt-2.5 text-[11px] text-dim/70">
          Esc approves with manual edit confirmations.
        </p>
      </div>
    </Modal>
  );
}

import { useRef, type ComponentProps } from "react";

import { AgentsDialog } from "./agents-dialog.js";
import { AskUserDialog } from "./ask-user-dialog.js";
import { CodeReviewDialog } from "./code-review-dialog.js";
import { FeedbackDialog } from "./feedback-dialog.js";
import type { InputDraft } from "./input-draft.js";
import { InputBox } from "./input.js";
import { IssueApprovalDialog } from "./issue-approval.js";
import { ModelSelect } from "./model-select.js";
import { PermissionDialog } from "./permission-dialog.js";
import { PlanApprovalDialog } from "./plan-approval.js";
import { ProviderLogin } from "./provider-login.js";
import { ProviderSelect } from "./provider-select.js";
import RewindDialog from "./rewind-dialog.js";
import { SessionSelector } from "./session-selector.js";
import { ThinkingSelect } from "./thinking-select.js";

interface Props {
  login?: ComponentProps<typeof ProviderLogin>;
  codeReview?: ComponentProps<typeof CodeReviewDialog>;
  provider?: ComponentProps<typeof ProviderSelect>;
  model?: ComponentProps<typeof ModelSelect>;
  thinking?: ComponentProps<typeof ThinkingSelect>;
  planApproval?: ComponentProps<typeof PlanApprovalDialog>;
  rewind?: ComponentProps<typeof RewindDialog>;
  resume?: ComponentProps<typeof SessionSelector>;
  permission?: ComponentProps<typeof PermissionDialog>;
  askUser?: ComponentProps<typeof AskUserDialog> & { requestId: number };
  feedback?: ComponentProps<typeof FeedbackDialog>;
  issueApproval?: ComponentProps<typeof IssueApprovalDialog>;
  agents?: ComponentProps<typeof AgentsDialog>;
  composer: ComponentProps<typeof InputBox>;
}

export function InteractionDock({
  login,
  codeReview,
  provider,
  model,
  thinking,
  planApproval,
  rewind,
  resume,
  permission,
  askUser,
  feedback,
  issueApproval,
  agents,
  composer,
}: Props) {
  const draftRef = useRef<InputDraft | null>(null);
  if (login) {
    return <ProviderLogin {...login} />;
  }
  if (codeReview) {
    return <CodeReviewDialog {...codeReview} />;
  }
  if (provider) {
    return <ProviderSelect {...provider} />;
  }
  if (model) {
    return <ModelSelect {...model} />;
  }
  if (planApproval) {
    return <PlanApprovalDialog {...planApproval} />;
  }
  if (rewind) {
    return <RewindDialog {...rewind} />;
  }
  if (resume) {
    return <SessionSelector {...resume} />;
  }
  if (permission) {
    return <PermissionDialog key={permission.requestId} {...permission} />;
  }
  if (askUser) {
    return <AskUserDialog key={askUser.requestId} {...askUser} />;
  }
  if (feedback) {
    return <FeedbackDialog {...feedback} />;
  }
  if (issueApproval) {
    return <IssueApprovalDialog {...issueApproval} />;
  }
  if (agents) {
    return <AgentsDialog {...agents} />;
  }
  if (thinking) {
    return <ThinkingSelect {...thinking} />;
  }
  return <InputBox {...composer} draftRef={draftRef} />;
}

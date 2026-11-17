import { useRef, type ComponentProps } from "react";

import { AgentsDialog } from "@/ui/agents-dialog.js";
import { AskUserDialog } from "@/ui/ask-user-dialog.js";
import type { InputDraft } from "@/ui/input-draft.js";
import { InputBox } from "@/ui/input.js";
import { ModelSelect } from "@/ui/model-select.js";
import { PermissionDialog } from "@/ui/permission-dialog.js";
import { PlanApprovalDialog } from "@/ui/plan-approval.js";
import { ProviderLogin } from "@/ui/provider-login.js";
import { ProviderSelect } from "@/ui/provider-select.js";
import RewindDialog from "@/ui/rewind-dialog.js";
import { SessionSelector } from "@/ui/session-selector.js";
import { ThinkingSelect } from "@/ui/thinking-select.js";
import { WorkflowsDialog } from "@/ui/workflows-dialog.js";

interface Props {
  login?: ComponentProps<typeof ProviderLogin>;
  provider?: ComponentProps<typeof ProviderSelect>;
  model?: ComponentProps<typeof ModelSelect>;
  thinking?: ComponentProps<typeof ThinkingSelect>;
  planApproval?: ComponentProps<typeof PlanApprovalDialog>;
  rewind?: ComponentProps<typeof RewindDialog>;
  resume?: ComponentProps<typeof SessionSelector>;
  permission?: ComponentProps<typeof PermissionDialog>;
  askUser?: ComponentProps<typeof AskUserDialog> & { requestId: number };
  agents?: ComponentProps<typeof AgentsDialog>;
  workflows?: ComponentProps<typeof WorkflowsDialog>;
  composer: ComponentProps<typeof InputBox>;
}

export function InteractionDock({
  login,
  provider,
  model,
  thinking,
  planApproval,
  rewind,
  resume,
  permission,
  askUser,
  agents,
  workflows,
  composer,
}: Props) {
  const draftRef = useRef<InputDraft | null>(null);
  if (login) {
    return <ProviderLogin {...login} />;
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
  if (agents) {
    return <AgentsDialog {...agents} />;
  }
  if (workflows) {
    return <WorkflowsDialog {...workflows} />;
  }
  if (thinking) {
    return <ThinkingSelect {...thinking} />;
  }
  return <InputBox {...composer} draftRef={draftRef} />;
}

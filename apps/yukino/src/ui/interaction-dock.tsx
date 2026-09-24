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

import { useRef, type ComponentProps } from "react";

import { AskUserDialog } from "./ask-user-dialog.js";
import type { InputDraft } from "./input-draft.js";
import { InputBox } from "./input.js";
import { PermissionDialog } from "./permission-dialog.js";
import { PlanApprovalDialog } from "./plan-approval.js";
import { ProviderLogin } from "./provider-login.js";
import { ProviderSelect } from "./provider-select.js";
import RewindDialog from "./rewind-dialog.js";
import { SessionSelector } from "./session-selector.js";
import { TeamsDialog } from "./teams-dialog.js";
import { ThinkingSelect } from "./thinking-select.js";

interface Props {
  login?: ComponentProps<typeof ProviderLogin>;
  provider?: ComponentProps<typeof ProviderSelect>;
  thinking?: ComponentProps<typeof ThinkingSelect>;
  planApproval?: ComponentProps<typeof PlanApprovalDialog>;
  rewind?: ComponentProps<typeof RewindDialog>;
  resume?: ComponentProps<typeof SessionSelector>;
  permission?: ComponentProps<typeof PermissionDialog>;
  askUser?: ComponentProps<typeof AskUserDialog>;
  teams?: ComponentProps<typeof TeamsDialog>;
  composer: ComponentProps<typeof InputBox>;
}

export function InteractionDock({
  login,
  provider,
  thinking,
  planApproval,
  rewind,
  resume,
  permission,
  askUser,
  teams,
  composer,
}: Props) {
  const draftRef = useRef<InputDraft | null>(null);
  if (login) {
    return <ProviderLogin {...login} />;
  }
  if (provider) {
    return <ProviderSelect {...provider} />;
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
    return <PermissionDialog {...permission} />;
  }
  if (askUser) {
    return <AskUserDialog {...askUser} />;
  }
  if (teams) {
    return <TeamsDialog {...teams} />;
  }
  if (thinking) {
    return <ThinkingSelect {...thinking} />;
  }
  return <InputBox {...composer} draftRef={draftRef} />;
}

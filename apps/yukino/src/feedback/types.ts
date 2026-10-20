import { z } from "zod";

import {
  ATTACHMENT_KINDS,
  MAX_ISSUE_BODY_CHARS,
  MAX_ISSUE_TITLE_CHARS,
} from "@/feedback/constants.js";

export const AttachmentKindSchema = z.enum(ATTACHMENT_KINDS);
export type AttachmentKind = z.infer<typeof AttachmentKindSchema>;

export interface FeedbackOptions {
  description: string;
  attachments: AttachmentKind[];
}

export const IssueDraftSchema = z.object({
  title: z.string().trim().min(1).max(MAX_ISSUE_TITLE_CHARS),
  body: z.string().max(MAX_ISSUE_BODY_CHARS),
});
export type IssueDraft = z.infer<typeof IssueDraftSchema>;

export const FeedbackChannelSchema = z.enum(["gh", "token", "browser"]);
export type FeedbackChannel = z.infer<typeof FeedbackChannelSchema>;

export const FiledIssueRecordSchema = z.object({
  fingerprint: z.string(),
  title: z.string(),
  url: z.string(),
  channel: FeedbackChannelSchema,
  gistUrl: z.string().optional(),
  createdAt: z.string(),
});
export type FiledIssueRecord = z.infer<typeof FiledIssueRecordSchema>;

/** User decision on the prepared issue list. */
export interface IssueConfirmation {
  approved: boolean;
  reason?: string;
}

export interface CollectedFile {
  /** Relative name inside the attachment bundle, e.g. "file-history/snapshots.json". */
  name: string;
  /** Redacted text content. */
  content: string;
  truncated: boolean;
}

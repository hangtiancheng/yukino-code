import { z } from "zod";

export const ATTACHMENT_KINDS = [
  "session",
  "tools",
  "file-history",
  "log",
  "env",
] as const;

export const AttachmentKindSchema = z.enum(ATTACHMENT_KINDS);
export type AttachmentKind = z.infer<typeof AttachmentKindSchema>;

export interface FeedbackOptions {
  description: string;
  attachments: AttachmentKind[];
}

export const IssueDraftSchema = z.object({
  title: z.string().min(1),
  body: z.string(),
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

export interface CollectedFile {
  /** Relative name inside the attachment bundle, e.g. "file-history/snapshots.json". */
  name: string;
  /** Redacted text content. */
  content: string;
  truncated: boolean;
}

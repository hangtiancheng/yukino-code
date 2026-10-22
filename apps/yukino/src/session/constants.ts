// Persistent session lines. Ordinary messages carry no `type`, while compaction boundary records
// have the type COMPACT_BOUNDARY. Their `content` is the JSON-serialized CompactBoundaryPayload
// (containing a summary and the retained recent tail messages).
// Inlining the retained tail directly into the boundary record avoids "physical location" issues:
// during restoration, reading the boundary is sufficient to reconstruct
// [summary] + retained messages + messages appended after the boundary, without needing to search
// for the retained messages in the area preceding the boundary.
export const COMPACT_BOUNDARY = "compact_boundary";

export const SESSION_EXPIRY_DAYS = 30;
export const INPUT_SESSION_MISMATCH =
  "User input does not belong to this project and session.";

export const SESSION_FILE_EXTENSION = ".jsonl";

// A rewind temp file is <session>.<pid>.rewind-tmp.
export const REWIND_TMP_SUFFIX = ".rewind-tmp";
export const REWIND_TMP_PATTERN = new RegExp(
  `\\.\\d+\\${REWIND_TMP_SUFFIX}$`,
  "u",
);

export const FIRST_MESSAGE_PREVIEW_CHARS = 100;

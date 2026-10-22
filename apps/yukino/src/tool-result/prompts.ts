import { TOOL_RESULT_PREVIEW_CHARS } from "@/tool-result/constants.js";

/**
 * The `<persisted-output>` wrapper text. buildSpillPreview reports in-memory
 * strings in characters; file-backed producers report stat and preview sizes
 * in bytes without ever loading the full content into JS.
 */
export function buildPersistedOutputPreview(
  totalSize: number,
  preview: string,
  spillPath: string,
  sizeUnit: "characters" | "bytes" = "characters",
): string {
  const previewSize =
    sizeUnit === "bytes" ? Buffer.byteLength(preview, "utf-8") : preview.length;
  let msg = `<persisted-output>\n`;
  msg += `Output too large (${String(totalSize)} ${sizeUnit}). Full content saved to:\n${spillPath}\n\n`;
  msg += `Preview (first ${String(previewSize)} ${sizeUnit}):\n${preview}`;
  if (totalSize > previewSize) {
    msg += "\n...";
  }
  msg += "\n</persisted-output>";
  return msg;
}

// Build the on-disk replacement text, including a 2000-char preview. Identical
// input yields a byte-for-byte identical string; once the replacement enters
// the conversation history it is never modified again.
export function buildSpillPreview(content: string, spillPath: string): string {
  return buildPersistedOutputPreview(
    content.length,
    content.slice(0, TOOL_RESULT_PREVIEW_CHARS),
    spillPath,
  );
}

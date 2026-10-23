// User-executed Bash ("!" prefix) core shared by the terminal UI and the
// remote server: parsing and execution through the Bash tool.

import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  USER_BASH_EXCLUDED_PREFIX,
  USER_BASH_INLINE_OUTPUT_BYTES,
  USER_BASH_INLINE_OUTPUT_LINES,
  USER_BASH_PREFIX,
} from "./constants.js";
import {
  mkdirPrivateSync as mkdirSync,
  writePrivateFileSync as writeFileSync,
} from "@yukino.js/storage/private.js";
import { spillDir } from "@yukino.js/tool-result";
import type { BashTool } from "@yukino.js/tools/bash.js";
import type { ToolContext, ToolResult } from "@yukino.js/tools/types.js";
import { asErrorString, plainTerminalText } from "@yukino.js/utils";

export function parseUserBashCommand(
  text: string,
): { command: string; excludeFromContext: boolean } | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith(USER_BASH_PREFIX)) {
    return null;
  }
  const excludeFromContext = trimmed.startsWith(USER_BASH_EXCLUDED_PREFIX);
  const prefixLength = excludeFromContext
    ? USER_BASH_EXCLUDED_PREFIX.length
    : USER_BASH_PREFIX.length;
  return {
    command: trimmed.slice(prefixLength).trim(),
    excludeFromContext,
  };
}

export async function executeUserBash(
  tool: BashTool,
  context: Pick<ToolContext, "cwd" | "sessionId" | "abortSignal" | "onOutput">,
  command: string,
  excludeFromContext: boolean,
): Promise<ToolResult> {
  const result = await tool.execute(
    {
      ...context,
      ...(excludeFromContext
        ? { taskManager: null, shellTimeoutDisabled: true }
        : {}),
    },
    { command },
  );
  const output = plainTerminalText(result.output);
  const bytes = Buffer.from(output, "utf8");
  if (
    bytes.length <= USER_BASH_INLINE_OUTPUT_BYTES &&
    output.split("\n").length <= USER_BASH_INLINE_OUTPUT_LINES
  ) {
    return { ...result, output };
  }
  const path = join(
    context.sessionId ? spillDir(context.sessionId) : tmpdir(),
    `user-bash-${randomUUID()}.txt`,
  );
  let start = Math.max(0, bytes.length - USER_BASH_INLINE_OUTPUT_BYTES);
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) {
    start++;
  }
  const tail = bytes
    .subarray(start)
    .toString("utf8")
    .split("\n")
    .slice(-USER_BASH_INLINE_OUTPUT_LINES)
    .join("\n");
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, output, { encoding: "utf8", mode: 0o600 });
  } catch (error) {
    return {
      output: `[Output truncated; could not save full output: ${asErrorString(error)}]\n${tail}`,
      isError: true,
    };
  }
  return {
    ...result,
    output: `[Output truncated; showing tail. Full output: ${path}]\n${tail}`,
  };
}

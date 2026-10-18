// User-executed Bash ("!" prefix) core shared by the terminal UI and the
// remote server: parsing, execution through the Bash tool, and the context
// line recorded into the conversation.

import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { UserBashResult } from "./index.js";

import {
  mkdirPrivateSync as mkdirSync,
  writePrivateFileSync as writeFileSync,
} from "@/storage/private.js";
import { spillDir } from "@/tool-result/index.js";
import type { BashTool } from "@/tools/bash.js";
import type { ToolContext, ToolResult } from "@/tools/types.js";
import { asErrorString, plainTerminalText } from "@/utils/index.js";

export function parseUserBashCommand(
  text: string,
): { command: string; excludeFromContext: boolean } | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("!")) {
    return null;
  }
  const excludeFromContext = trimmed.startsWith("!!");
  return {
    command: trimmed.slice(excludeFromContext ? 2 : 1).trim(),
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
  if (bytes.length <= 50 * 1024 && output.split("\n").length <= 2000) {
    return { ...result, output };
  }
  const path = join(
    context.sessionId ? spillDir(context.sessionId) : tmpdir(),
    `user-bash-${randomUUID()}.txt`,
  );
  let start = Math.max(0, bytes.length - 50 * 1024);
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) {
    start++;
  }
  const tail = bytes
    .subarray(start)
    .toString("utf8")
    .split("\n")
    .slice(-2000)
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

export function userBashContext(result: UserBashResult): string {
  return `User executed Bash (${result.status}):\n$ ${result.command}\n\n${result.output}`;
}

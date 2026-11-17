import type { Message } from "@/conversation/index.js";

/** Only completed writes count as saved memories; assistant prose is not execution evidence. */
export function extractWrittenPaths(messages: Message[]): string[] {
  const successful = new Set(
    messages.flatMap((message) =>
      (message.toolResults ?? [])
        .filter((result) => !result.isError)
        .map((result) => result.toolUseId),
    ),
  );
  const paths = new Set<string>();
  for (const message of messages) {
    for (const tool of message.toolUses ?? []) {
      if (
        (tool.toolName === "WriteFile" || tool.toolName === "EditFile") &&
        successful.has(tool.toolUseId) &&
        typeof tool.arguments.file_path === "string"
      ) {
        paths.add(tool.arguments.file_path);
      }
    }
  }
  return [...paths];
}

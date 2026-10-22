import { MCP_INSTRUCTIONS_MARKER } from "@/mcp/constants.js";
import type { McpInstruction } from "@/mcp/instructions.js";

export function formatMcpInstructionsDelta(
  added: McpInstruction[],
  removed: string[],
): string {
  const parts: string[] = [];
  if (added.length > 0) {
    const blocks = added
      .map(({ serverName, text }) => `## ${serverName}\n${text}`)
      .join("\n\n");
    parts.push(
      `${MCP_INSTRUCTIONS_MARKER}\n\nThe following MCP servers have connected and provide instructions for how to use their tools and resources:\n\n${blocks}`,
    );
  }
  if (removed.length > 0) {
    parts.push(
      `The following MCP servers have disconnected. Their instructions above no longer apply:\n${removed.join("\n")}`,
    );
  }
  return parts.join("\n\n");
}

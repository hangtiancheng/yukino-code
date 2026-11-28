import { MCP_INSTRUCTIONS_MARKER } from "@/mcp/constants.js";
import type { McpInstruction } from "@/mcp/instructions.js";

export const MCP_RESOURCES_DESCRIPTION =
  "List a connected MCP server's resources or URI templates. Resource URIs are provenance, never local filesystem destinations. Apps resources use the dedicated Apps host.";
export const MCP_READ_RESOURCE_DESCRIPTION =
  "Read an MCP resource by server and URI, returning a bounded safe preview and host-owned full-content artifact. Does not execute resource content or fetch linked URLs. ui:// resources require the dedicated Apps host.";

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

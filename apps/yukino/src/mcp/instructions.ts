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

/**
 * Announces MCP server instructions as deltas.
 *
 * Server instructions are guidance the model cannot derive from a tool schema, so
 * they have to reach the conversation. Re-sending a full snapshot on every connect
 * pass repeats that guidance — a few hundred tokens per pass — and the system prompt
 * cannot carry it either: tools and history follow the system prompt, so a late MCP
 * connect would invalidate the cached prefix of the whole conversation.
 *
 * So the announcement is incremental: newly connected servers are added, and servers
 * whose instructions were announced but are no longer connected are retracted. Which
 * servers were announced lives in the caller (a Set), but history is the source of
 * truth for it: /clear, /resume and compaction all drop the reminder, and once the
 * marker is gone from history nothing is announced any more, so everything has to go
 * out again.
 */

/** Heading every announcement carries; also the marker history is scanned for. */
export const MCP_INSTRUCTIONS_MARKER = "# MCP Server Instructions";

export interface McpInstruction {
  serverName: string;
  text: string;
}

/** The part of MCPManager this module needs, so tests can stand in for it. */
export interface McpInstructionSource {
  connectedServers(): string[];
  connectedInstructions(): McpInstruction[];
}

/** The part of ConversationManager this module needs. */
export interface ReminderHistory {
  hasReminderContaining(marker: string): boolean;
  addSystemReminder(content: string): void;
}

/**
 * Injects the delta between what the model has been told and what is connected now.
 * Returns true when a reminder was appended, false when nothing changed.
 */
export function syncMcpInstructions(
  history: ReminderHistory,
  announced: Set<string>,
  source: McpInstructionSource,
): boolean {
  if (!history.hasReminderContaining(MCP_INSTRUCTIONS_MARKER)) {
    announced.clear();
  }

  const live = new Set(source.connectedServers());
  const added = source
    .connectedInstructions()
    .filter(({ serverName }) => !announced.has(serverName))
    .sort((a, b) => a.serverName.localeCompare(b.serverName));
  // A server that is connected but advertises no instructions was never announced,
  // so it can never be retracted either.
  const removed = [...announced].filter((name) => !live.has(name)).sort();

  if (added.length === 0 && removed.length === 0) {
    return false;
  }
  for (const { serverName } of added) {
    announced.add(serverName);
  }
  for (const serverName of removed) {
    announced.delete(serverName);
  }

  history.addSystemReminder(formatMcpInstructionsDelta(added, removed));
  return true;
}

function formatMcpInstructionsDelta(
  added: McpInstruction[],
  removed: string[],
): string {
  const parts: string[] = [];
  if (added.length > 0) {
    const blocks = added
      .map(({ serverName, text }) => `## ${serverName}\n${text}`)
      .join("\n\n");
    parts.push(
      `${MCP_INSTRUCTIONS_MARKER}\n\nThe following MCP servers have provided instructions for how to use their tools and resources:\n\n${blocks}`,
    );
  }
  if (removed.length > 0) {
    parts.push(
      `The following MCP servers have disconnected. Their instructions above no longer apply:\n${removed.join("\n")}`,
    );
  }
  return parts.join("\n\n");
}

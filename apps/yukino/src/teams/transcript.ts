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

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

import z, { parse } from "zod";

import type { ConversationManager } from "@/conversation/index.js";
import { createChildLogger } from "@/logger/index.js";
import { contentToText } from "@/utils/index.js";

const log = createChildLogger({ module: "teams" });

// Serialized data structure
const TranscriptToolUseSchema = z.object({
  tool_use_id: z.string(),
  tool_name: z.string(),
  arguments: z.record(z.string(), z.unknown()),
});

const TranscriptToolResultSchema = z.object({
  tool_use_id: z.string(),
  content: z.string(),
  is_error: z.boolean().optional(),
});

const TranscriptEntrySchema = z.object({
  role: z.string(),
  content: z.string().optional(),
  tool_uses: z.array(TranscriptToolUseSchema).optional(),
  tool_results: z.array(TranscriptToolResultSchema).optional(),
});

export type TranscriptEntry = z.infer<typeof TranscriptEntrySchema>;

// Serialization / Deserialization

/**
 * Serializes the conversation history into a list of persistable entries.
 */

function serializeConversation(
  conversation: ConversationManager,
): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  for (const msg of conversation.getMessages()) {
    const entry: TranscriptEntry = {
      role: msg.role,
      content: contentToText(msg.content),
    };
    if (msg.toolUses && msg.toolUses.length > 0) {
      entry.tool_uses = msg.toolUses.map((tu) => ({
        tool_use_id: tu.toolUseId,
        tool_name: tu.toolName,
        arguments: tu.arguments,
      }));
    }
    if (msg.toolResults && msg.toolResults.length > 0) {
      entry.tool_results = msg.toolResults.map((tr) => ({
        tool_use_id: tr.toolUseId,
        content: tr.content,
        is_error: tr.isError || undefined,
      }));
    }
    entries.push(entry);
  }
  return entries;
}

/**
 * Returns the storage directory for team transcripts.
 */
function transcriptDir(workDir: string, teamName: string): string {
  return join(workDir, ".yukino", "teams", teamName, "transcripts");
}

/**
 * Persists a teammate's conversation history to disk for debugging and troubleshooting.
 * File path: .yukino/teams/{team}/transcripts/{agentId}.json
 */
export function saveTranscript(
  workDir: string,
  teamName: string,
  agentId: string,
  conversation: ConversationManager,
): string {
  const dir = transcriptDir(workDir, teamName);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${agentId}.json`);
  const data = serializeConversation(conversation);
  writeFileSync(path, JSON.stringify(data, null, 2), "utf-8");
  return path;
}

/**
 Loads a teammate's conversation history from disk.
 Returns null if the file does not exist or parsing fails.
 */
export function loadTranscript(
  workDir: string,
  teamName: string,
  agentId: string,
): TranscriptEntry[] | null {
  const path = join(transcriptDir(workDir, teamName), `${agentId}.json`);
  if (!existsSync(path)) {
    return null;
  }
  try {
    const raw: unknown = JSON.parse(readFileSync(path, "utf-8"));
    const parsed = parse(z.array(TranscriptEntrySchema), raw);
    return parsed;
  } catch (err) {
    log.error({ err }, "teams operation failed");
    return null;
  }
}

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

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { modules } from "./tools/index.js";
import { version } from "./version.js";

export const SERVER_NAME = "yukino-mcp";

// Surfaced to clients at initialize time; yukino injects it into the model's
// context, improving tool selection.
const INSTRUCTIONS =
  "yukino-mcp provides tools for the Yukino CLI. Use docs to semantically " +
  "search the user's local knowledge base (Markdown/text files under ~/.yukino/docs) " +
  "whenever a question may be covered by project- or team-specific documents, " +
  "runbooks or notes. Use create_app to display a self-contained HTML document as an " +
  "interactive app (charts, dashboards, calculators, visual demos) inline in the " +
  "conversation when the user wants to see or interact with a result rather than " +
  "read text. Before using browser automation tools, call tabs_context_mcp to discover " +
  "the available Chrome tabs and their tab IDs.";

// registerTool throws on duplicate names — with per-request server instances
// in HTTP mode that would surface as runtime 500s, so fail fast at startup.
function assertUniqueModuleNames(): void {
  const seen = new Set<string>();
  for (const module of modules) {
    if (seen.has(module.name)) {
      throw new Error(`duplicate tool module name: ${module.name}`);
    }
    seen.add(module.name);
  }
}
assertUniqueModuleNames();

/**
 * Build an MCP server with every tool module registered. Cheap to call:
 * the HTTP transports create one instance per session/request while module
 * state stays in process-wide singletons.
 */
export function createServer(): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version },
    { instructions: INSTRUCTIONS },
  );
  for (const module of modules) {
    module.register(server);
  }
  return server;
}

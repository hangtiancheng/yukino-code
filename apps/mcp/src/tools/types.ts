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

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/**
 * A self-contained tool module. `register` is called once per McpServer
 * instance (the HTTP transports create a server per session/request), while
 * `init`/`shutdown` manage process-wide singleton state (connections, caches).
 */
export interface ToolModule {
  /** Unique module name, used in logs. */
  name: string;
  /** Register the module's tools on an MCP server instance. */
  register(server: McpServer): void;
  /** Optional background initialization kicked off after transport connect. */
  init?(): Promise<void>;
  /** Optional graceful shutdown. */
  shutdown?(): Promise<void>;
}

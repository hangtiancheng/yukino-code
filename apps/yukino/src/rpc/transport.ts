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

// RemoteTransport selects which Go agent-bridge transport the terminal UI
// drives instead of its in-process agent. All three speak the same logical
// protocol (prompts in, agent events out, permission/question prompts answered
// in-band) and reduce to the same AgentRpc surface, so the UI is identical
// regardless of the wire format:
//
//   - connect: protobuf/Connect over HTTP (yukino/pb, cmd/yukino-code-rpc)
//   - ws:      JSON-RPC 2.0 over a websocket (yukino/ws, cmd/yukino-code-ws)
//   - stdio:   JSON-RPC 2.0 over a spawned child's stdin/stdout (yukino/stdio,
//              cmd/yukino-code-stdio)

import { createAgentRpc, type AgentRpc } from "./client.js";
import { createStdioAgentRpc } from "./stdio-client.js";
import { createWsAgentRpc } from "./ws-client.js";

/** Which Go bridge transport to drive, and how to reach it. */
export type RemoteTransport =
  | { kind: "connect"; url: string }
  | { kind: "ws"; url: string }
  | { kind: "stdio"; command: string; args: string[] };

/** createAgentRpcFor builds the AgentRpc client for the chosen transport. */
export function createAgentRpcFor(remote: RemoteTransport): AgentRpc {
  switch (remote.kind) {
    case "connect":
      return createAgentRpc({ url: remote.url });
    case "ws":
      return createWsAgentRpc({ url: remote.url });
    case "stdio":
      return createStdioAgentRpc({
        command: remote.command,
        args: remote.args,
      });
  }
}

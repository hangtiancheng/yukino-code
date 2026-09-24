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

import { runAcpStdio } from "./stdio.js";
import { runAcpWebSocket } from "./websocket.js";

// Submodule namespaces for library consumers (Acp.Agent.*, Acp.Stdio.*, ...).
// Namespaced re-exports keep submodule symbols out of the flat barrel, so they
// cannot collide with other groups' `export *` names.
export * as Agent from "./agent.js";
export * as Conversion from "./conversion.js";
export * as Stdio from "./stdio.js";
export * as Websocket from "./websocket.js";

export type AcpMode =
  { transport: "stdio" } | { transport: "websocket"; address?: string };

export function parseAcpMode(args: string[]): AcpMode | null {
  const stdioIndex = args.indexOf("--acp");
  const websocketIndex = args.indexOf("--acp-ws");
  if (stdioIndex === -1 && websocketIndex === -1) {
    return null;
  }
  if (stdioIndex !== -1 && websocketIndex !== -1) {
    throw new Error("Use either --acp or --acp-ws, not both.");
  }
  if (stdioIndex !== -1) {
    if (args.length !== 1) {
      throw new Error("--acp cannot be combined with other CLI options.");
    }
    return { transport: "stdio" };
  }

  const address = args[websocketIndex + 1];
  const consumed = address && !address.startsWith("-") ? 2 : 1;
  if (args.length !== consumed) {
    throw new Error("--acp-ws accepts only an optional host:port address.");
  }
  return {
    transport: "websocket",
    ...(consumed === 2 ? { address } : {}),
  };
}

export async function runAcp(args: string[]): Promise<void> {
  const mode = parseAcpMode(args);
  if (!mode) {
    throw new Error("ACP mode was not selected.");
  }
  if (mode.transport === "stdio") {
    await runAcpStdio();
    return;
  }
  await runAcpWebSocket(mode.address);
}

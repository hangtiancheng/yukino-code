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

// Stdio client for the Yukino agent bridge's stdio server (yukino/stdio, served
// by cmd/yukino-code-stdio). Unlike the Connect and websocket transports there
// is no server to dial: the bridge is spawned as a child process and spoken to
// over its stdin/stdout as newline-delimited JSON-RPC 2.0. It implements the
// same AgentRpc surface, so a RemoteAgent drives it unchanged.
//
// The child is spawned lazily on first use (watch or a request), keeping the
// factory side-effect-free like the other transports. There is no attach race:
// the Go bridge attaches its stdout connection before it reads stdin, and the OS
// pipe buffers the first prompt until it does. Disposing closes stdin, which the
// bridge treats as EOF and a clean shutdown, then signals the process.

import { spawn, type ChildProcess } from "node:child_process";

import type {
  AgentRpc,
  PermissionAnswer,
  RemoteEvent,
  RpcContentBlock,
} from "./client.js";
import {
  EventQueue,
  JsonRpcPeer,
  mapJsonRpcEvent,
  promptPayload,
  readBoolFlag,
  readProviderResult,
} from "./jsonrpc.js";

/** Options for createStdioAgentRpc. */
export interface StdioAgentRpcOptions {
  /** Executable to spawn, e.g. a built yukino-code-stdio binary. */
  command: string;
  /** Extra arguments for the child. */
  args?: string[];
  /** Working directory for the child; defaults to the current one. */
  cwd?: string;
  /** Environment for the child; defaults to the current one. */
  env?: NodeJS.ProcessEnv;
}

// stderrTailCap bounds how much child stderr is kept to explain a failure.
const stderrTailCap = 4096;

/** createStdioAgentRpc builds a Node/Ink client for the bridge's stdio transport. */
export function createStdioAgentRpc(opts: StdioAgentRpcOptions): AgentRpc {
  const queue = new EventQueue();

  let child: ChildProcess | null = null;
  let peer: JsonRpcPeer | null = null;
  let stderrTail = "";
  let disposed = false;

  function appendStderr(chunk: string): void {
    stderrTail = (stderrTail + chunk).slice(-stderrTailCap);
  }

  function failure(detail: string): Error {
    const tail = stderrTail.trim();
    return new Error(tail ? `${detail}: ${tail}` : detail);
  }

  // ensureChild spawns the bridge once and wires its streams. stdout carries the
  // protocol (newline-delimited JSON-RPC); stderr is diagnostics only and is kept
  // as a rolling tail to explain a crash without writing into the terminal UI.
  function ensureChild(): JsonRpcPeer {
    if (disposed) {
      throw new Error("stdio agent bridge is disposed");
    }
    if (peer) {
      return peer;
    }
    const proc = spawn(opts.command, opts.args ?? [], {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    child = proc;

    const p = new JsonRpcPeer((encoded) => {
      proc.stdin?.write(`${encoded}\n`);
    });
    p.onNotification((method, params) => {
      const ev = mapJsonRpcEvent(method, params);
      if (ev) {
        queue.push(ev);
      }
    });
    peer = p;

    let buf = "";
    proc.stdout?.setEncoding("utf8");
    proc.stdout?.on("data", (chunk: string) => {
      buf += chunk;
      let nl = buf.indexOf("\n");
      while (nl >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.trim().length > 0) {
          p.feed(line);
        }
        nl = buf.indexOf("\n");
      }
    });
    proc.stderr?.setEncoding("utf8");
    proc.stderr?.on("data", (chunk: string) => {
      appendStderr(chunk);
    });

    proc.on("error", (err) => {
      p.failAll(err);
      if (!disposed) {
        queue.push({ type: "error", error: err });
      }
      queue.close();
    });
    proc.on("close", () => {
      p.failAll(new Error("agent bridge process exited"));
      if (!disposed) {
        queue.push({
          type: "error",
          error: failure("agent bridge process exited"),
        });
      }
      queue.close();
    });
    return p;
  }

  function request(method: string, params?: unknown): Promise<unknown> {
    const p = ensureChild();
    return p.request(method, params);
  }

  function teardown(): void {
    if (disposed) {
      return;
    }
    disposed = true;
    queue.close();
    peer?.failAll(new Error("stdio agent bridge disposed"));
    const proc = child;
    child = null;
    peer = null;
    if (!proc) {
      return;
    }
    // Closing stdin ends the bridge's read loop (EOF) for a clean shutdown; the
    // signal is a fallback for a process that no longer reads.
    try {
      proc.stdin?.end();
    } catch {
      /** noop */
    }
    try {
      proc.kill("SIGTERM");
    } catch {
      /** noop */
    }
  }

  return {
    async *watch(signal?: AbortSignal): AsyncIterable<RemoteEvent> {
      try {
        ensureChild();
      } catch (err) {
        queue.push({
          type: "error",
          error: err instanceof Error ? err : new Error(String(err)),
        });
        queue.close();
      }
      if (signal) {
        if (signal.aborted) {
          teardown();
          return;
        }
        signal.addEventListener(
          "abort",
          () => {
            teardown();
          },
          { once: true },
        );
      }
      yield* queue.iterate();
    },
    async sendPrompt(content: string): Promise<boolean> {
      const res = await request("session/prompt", { content });
      return readBoolFlag(res, "queued");
    },
    async sendPromptBlocks(blocks: RpcContentBlock[]): Promise<boolean> {
      const res = await request("session/prompt", promptPayload(blocks));
      return readBoolFlag(res, "queued");
    },
    async respondPermission(
      id: string,
      answer: PermissionAnswer,
    ): Promise<boolean> {
      const res = await request("permission/respond", {
        id,
        response: answer,
      });
      return readBoolFlag(res, "applied");
    },
    async respondQuestions(
      id: string,
      answers: Record<string, string>,
    ): Promise<boolean> {
      const res = await request("question/respond", { id, answers });
      return readBoolFlag(res, "applied");
    },
    async cancel(): Promise<void> {
      await request("session/cancel");
    },
    async ping(): Promise<void> {
      await request("ping");
    },
    async selectProvider(name: string) {
      const res = await request("session/select_provider", { name });
      return readProviderResult(res);
    },
    dispose(): void {
      teardown();
    },
  };
}

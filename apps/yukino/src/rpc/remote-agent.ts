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

// RemoteAgent is the RPC-mode stand-in for the in-process Agent: it drives the
// bridge session through an AgentRpc connection instead of running the loop
// locally. The UI boundary is identical — `run()` yields the same event
// stream app.tsx iterates — with two differences imposed by the transport:
//
//   - The Watch stream attaches once and outlives individual turns; each
//     `run()` call drains events until the turn settles (loop_complete or an
//     error), then returns. Interrupts call the Cancel RPC — unlike the local
//     agent, aborting the stream alone would leave the server-side run going.
//   - Permission and question prompts arrive as streamed events; the adapter
//     routes them to the host callbacks (the same dialogs the local agent
//     triggers) and answers them with the respond RPCs, so the loop never
//     leaves the UI layer.

import type {
  AgentRpc,
  PermissionAnswer,
  RemoteEvent,
  RpcContentBlock,
  RpcQuestion,
} from "./client.js";

/** Host hooks the UI supplies for the blocking prompts. */
export interface RemoteAgentHooks {
  /** Answers a permission prompt; default when absent: deny. */
  onPermissionRequest?: (
    toolName: string,
    description: string,
  ) => Promise<PermissionAnswer>;
  /** Answers an AskUserQuestion prompt; default when absent: empty answers. */
  onQuestions?: (questions: RpcQuestion[]) => Promise<Record<string, string>>;
}

export class RemoteAgent {
  private queue: RemoteEvent[] = [];
  private waiters: ((ev: RemoteEvent | null) => void)[] = [];
  private done = false;
  private pumpStarted = false;
  private watchAbort = new AbortController();

  constructor(
    private rpc: AgentRpc,
    private hooks: RemoteAgentHooks = {},
  ) {}

  /**
   * Yields events for one turn: everything from the current position until
   * (and including) loop_complete or an error event. The underlying Watch
   * stream stays attached across calls.
   */
  async *run(): AsyncGenerator<RemoteEvent> {
    this.startPump();
    while (true) {
      const ev = await this.shift();
      if (ev === null) {
        return;
      }
      yield ev;
      if (ev.type === "loop_complete" || ev.type === "error") {
        return;
      }
    }
  }

  /**
   * Queues one user turn on the server; returns whether it was accepted. Pass a
   * string for a text-only turn, or content blocks for a multimodal turn.
   */
  send(content: string | RpcContentBlock[]): Promise<boolean> {
    return typeof content === "string"
      ? this.rpc.sendPrompt(content)
      : this.rpc.sendPromptBlocks(content);
  }

  /**
   * Interrupts the running turn. The run ends as loop_complete/interrupted on
   * the stream, exactly like the local abort path.
   */
  async interrupt(): Promise<void> {
    await this.rpc.cancel().catch(() => {
      // Nothing to interrupt or the server is gone; the Watch loop surfaces
      // either outcome.
    });
  }

  /** Detaches from the session; further `run()` calls end immediately. */
  dispose(): void {
    this.watchAbort.abort();
    this.close();
  }

  private startPump(): void {
    if (this.pumpStarted) {
      return;
    }
    this.pumpStarted = true;
    void (async () => {
      try {
        for await (const ev of this.rpc.watch(this.watchAbort.signal)) {
          await this.route(ev);
        }
      } catch (err) {
        if (!this.watchAbort.signal.aborted) {
          this.push({
            type: "error",
            error: err instanceof Error ? err : new Error(String(err)),
          });
        }
      } finally {
        this.close();
      }
    })();
  }

  // Serves the blocking prompts in-band: the server-side run waits on the
  // respond RPC, so the event never reaches the UI queue.
  private async route(ev: RemoteEvent): Promise<void> {
    switch (ev.type) {
      case "rpc_permission_request": {
        const answer = this.hooks.onPermissionRequest
          ? await this.hooks.onPermissionRequest(ev.toolName, ev.description)
          : ("deny" as const);
        await this.rpc.respondPermission(ev.id, answer).catch(() => {
          /** noop */
        });
        return;
      }
      case "question_ask": {
        const answers = this.hooks.onQuestions
          ? await this.hooks.onQuestions(ev.questions)
          : {};
        await this.rpc.respondQuestions(ev.id, answers).catch(() => {
          /** noop */
        });
        return;
      }
      default:
        this.push(ev);
    }
  }

  private push(ev: RemoteEvent): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter(ev);
    } else {
      this.queue.push(ev);
    }
  }

  private close(): void {
    if (this.done) {
      return;
    }
    this.done = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter(null);
    }
  }

  private shift(): Promise<RemoteEvent | null> {
    if (this.queue.length > 0) {
      return Promise.resolve(this.queue.shift() ?? null);
    }
    if (this.done) {
      return Promise.resolve(null);
    }
    return new Promise((resolve) => this.waiters.push(resolve));
  }
}

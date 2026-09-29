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

import { exec } from "node:child_process";

import type { HookConfig } from "@/config/index.js";
import { createChildLogger } from "@/logger/index.js";
import { asErrorString } from "@/utils/index.js";
import { strArg } from "@/utils/index.js";

const log = createChildLogger({ module: "hooks" });

/** Async command execution for hooks — non-blocking, 30s timeout, so the
 * event loop isn't frozen during hook commands. POSIX hooks intentionally use
 * Bash; Windows keeps Node's platform default (ComSpec/cmd) because Bash is not
 * guaranteed to be installed there. */
function execHookAsync(
  command: string,
  opts: { env: NodeJS.ProcessEnv; cwd?: string; signal?: AbortSignal },
): Promise<string> {
  return new Promise((resolve, reject) => {
    exec(
      command,
      {
        encoding: "utf-8",
        timeout: 30000,
        env: opts.env,
        cwd: opts.cwd,
        signal: opts.signal,
        maxBuffer: 10 * 1024 * 1024,
        ...(process.platform === "win32" ? {} : { shell: "bash" }),
      },
      (err, stdout) => {
        if (err) {
          reject(err);
        } else {
          resolve(stdout);
        }
      },
    );
  });
}

export type EventName =
  | "session_start"
  | "session_end"
  | "turn_start"
  | "turn_end"
  | "pre_send"
  | "post_receive"
  | "pre_tool_use"
  | "post_tool_use"
  | "shutdown";

export interface HookContext {
  event: EventName;
  toolName?: string;
  args?: Record<string, unknown>;
  filePath?: string;
  message?: string | undefined;
}

export interface HookResult {
  output: string;
  success: boolean;
  reject: boolean;
}

export interface HookRuntimeOptions {
  workDir?: string;
  abortSignal?: AbortSignal;
}

export class HookEngine {
  private hooks: HookConfig[];
  private firedOnce = new Set<string>();
  private notifications: string[] = [];
  // Executor for agent-type hooks, injected externally. Executing one without a
  // registered runner throws a clear error. No host registers one today (only
  // tests do), so agent-type hooks currently always fail at runtime.
  agentRunner?: (prompt: string, ctx: HookContext) => Promise<string>;

  constructor(hooks: HookConfig[]) {
    this.hooks = hooks;
  }

  // Queue a message produced by a hook so the agent loop can surface it as a
  // system reminder on the next turn.
  recordNotification(message: string): void {
    if (message.trim()) {
      this.notifications.push(message);
    }
  }

  drainNotifications(): string[] {
    const out = this.notifications;
    this.notifications = [];
    return out;
  }

  async fire(
    event: EventName,
    context: HookContext,
    options: HookRuntimeOptions = {},
  ): Promise<HookResult[]> {
    const results: HookResult[] = [];

    for (const [index, hook] of this.hooks.entries()) {
      if (options.abortSignal?.aborted) {
        break;
      }
      if (hook.event !== event) {
        continue;
      }

      if (hook.condition && !evaluateCondition(hook.condition, context)) {
        continue;
      }

      // Once-slot key, computed once: claimed before execution and released
      // again when a sync execution fails — a once-hook that errored has not
      // "fired", and the next matching event should retry it.
      const onceKey = hook.once
        ? hook.id === undefined
          ? `index:${String(index)}`
          : `id:${hook.id}`
        : null;
      if (onceKey !== null) {
        if (this.firedOnce.has(onceKey)) {
          continue;
        }
        this.firedOnce.add(onceKey);
      }

      // Async hook: execute in the background without blocking the main flow
      if (hook.async) {
        this.executeAction(hook, context, options)
          .then((r) => {
            this.recordNotification(r.output);
          })
          .catch((err: unknown) => {
            log.error({ err }, "hooks operation failed");
            if (onceKey !== null) {
              this.firedOnce.delete(onceKey);
            }
            // Same on_error semantics as the sync path: "ignore" stays
            // silent beyond the log; anything else surfaces the error.
            if ((hook.on_error ?? "ignore") !== "ignore") {
              this.recordNotification(
                `Async hook error: ${asErrorString(err)}`,
              );
            }
          });
        continue;
      }

      try {
        const result = await this.executeAction(hook, context, options);
        results.push(result);

        if (result.reject && event === "pre_tool_use") {
          break;
        }
      } catch (err) {
        log.error({ err }, "hooks operation failed");
        if (onceKey !== null) {
          this.firedOnce.delete(onceKey);
        }
        const onError = hook.on_error ?? "ignore";
        if (onError === "fail") {
          const msg = `Hook error: ${asErrorString(err)}`;
          results.push({ output: msg, success: false, reject: false });
        } else if (onError === "reject") {
          const msg = `Hook error (rejecting): ${asErrorString(err)}`;
          results.push({ output: msg, success: false, reject: true });
          if (event === "pre_tool_use") {
            break;
          }
        }
      }
    }

    return results;
  }

  async firePreToolHooks(
    toolName: string,
    args: Record<string, unknown>,
    options: HookRuntimeOptions = {},
  ): Promise<{ rejected: boolean; reason: string }> {
    const context: HookContext = {
      event: "pre_tool_use",
      toolName,
      args,
      filePath: strArg(args, "file_path", strArg(args, "path", "")),
    };

    const results = await this.fire("pre_tool_use", context, options);
    for (const r of results) {
      if (r.reject) {
        return { rejected: true, reason: r.output };
      }
      this.recordNotification(r.output);
    }
    return { rejected: false, reason: "" };
  }

  private async executeAction(
    hook: HookConfig,
    context: HookContext,
    options: HookRuntimeOptions,
  ): Promise<HookResult> {
    switch (hook.action.type) {
      case "command": {
        const command = hook.action.command ?? "";
        try {
          const output = await execHookAsync(command, {
            cwd: options.workDir,
            signal: options.abortSignal,
            env: {
              ...process.env,
              YUKINO_EVENT: context.event,
              YUKINO_TOOL: context.toolName ?? "",
              YUKINO_FILE_PATH: context.filePath ?? "",
            },
          });
          return {
            output: output.trim(),
            success: true,
            reject: hook.reject ?? false,
          };
        } catch (err) {
          log.error({ err }, "hooks operation failed");
          throw err;
        }
      }

      case "prompt": {
        return {
          output: hook.action.prompt ?? "",
          success: true,
          reject: hook.reject ?? false,
        };
      }

      case "http": {
        const url = hook.action.url ?? "";
        const method = (hook.action.method ?? "POST").toUpperCase();
        try {
          const resp = await fetch(url, {
            method,
            headers: { "Content-Type": "application/json" },
            ...(method === "GET" || method === "HEAD"
              ? {}
              : { body: JSON.stringify(context) }),
            signal: options.abortSignal
              ? AbortSignal.any([
                  options.abortSignal,
                  AbortSignal.timeout(30000),
                ])
              : AbortSignal.timeout(30000),
          });
          if (!resp.ok) {
            await resp.body?.cancel();
            throw new Error(
              `HTTP hook failed with status ${String(resp.status)}`,
            );
          }
          const text = await resp.text();
          return {
            output: text,
            success: resp.ok,
            reject: hook.reject ?? false,
          };
        } catch (err) {
          log.error({ err }, "hooks operation failed");
          throw err;
        }
      }

      case "agent": {
        if (!this.agentRunner) {
          throw new Error(
            "agent-type hook configured but no AgentRunner registered",
          );
        }
        const prompt = hook.action.prompt ?? hook.action.command ?? "";
        try {
          const output = await this.agentRunner(prompt, context);
          return { output, success: true, reject: hook.reject ?? false };
        } catch (err) {
          log.error({ err }, "hooks operation failed");
          throw err;
        }
      }

      default:
        return { output: "", success: true, reject: false };
    }
  }
}

type ConditionFn = (
  event: string,
  tool: string,
  filePath: string,
  message: string,
  args: Record<string, unknown>,
) => unknown;

/**
 * Compiles a condition into a JavaScript expression evaluated against the
 * hook context. The config file already grants arbitrary shell execution
 * through command actions, so evaluating expressions from the same source
 * adds no new privilege.
 */
function compileCondition(condition: string): ConditionFn {
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const fn = new Function(
    "event",
    "tool",
    "filePath",
    "message",
    "args",
    `"use strict"; return (${condition});`,
  );
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  return fn as ConditionFn;
}

function evaluateCondition(condition: string, ctx: HookContext): boolean {
  try {
    return Boolean(
      compileCondition(condition)(
        ctx.event,
        ctx.toolName ?? "",
        ctx.filePath ?? "",
        ctx.message ?? "",
        ctx.args ?? {},
      ),
    );
  } catch (err) {
    log.error({ err, condition }, "hook condition evaluation failed");
    return false;
  }
}

export function validate(hooks: HookConfig[]): Error | null {
  const validEvents = new Set<string>([
    "session_start",
    "session_end",
    "turn_start",
    "turn_end",
    "pre_send",
    "post_receive",
    "pre_tool_use",
    "post_tool_use",
    "shutdown",
  ]);
  const validActions = new Set(["command", "prompt", "http", "agent"]);

  const errors: string[] = [];

  for (let i = 0; i < hooks.length; i++) {
    const h = hooks[i];
    const label = h.id
      ? `hook[${String(i)}] (id="${h.id}")`
      : `hook[${String(i)}]`;

    if (!h.event) {
      errors.push(`${label}: event is required`);
    } else if (!validEvents.has(h.event)) {
      errors.push(`${label}: invalid event '${h.event}'`);
    }

    if (!h.action.type) {
      errors.push(`${label}: action.type is required`);
    } else if (!validActions.has(h.action.type)) {
      errors.push(`${label}: invalid action type '${h.action.type}'`);
    } else {
      switch (h.action.type) {
        case "command":
          if (!h.action.command?.trim()) {
            errors.push(
              `${label}: action.command must be non-empty for type "command"`,
            );
          }
          break;
        case "prompt":
          if (!h.action.prompt?.trim()) {
            errors.push(
              `${label}: action.prompt must be non-empty for type "prompt"`,
            );
          }
          break;
        case "http":
          if (!h.action.url?.trim()) {
            errors.push(
              `${label}: action.url must be non-empty for type "http"`,
            );
          }
          break;
        case "agent":
          if (!h.action.prompt?.trim() && !h.action.command?.trim()) {
            errors.push(
              `${label}: action.prompt (or action.command) must be non-empty for type "agent"`,
            );
          }
          // No host registers an agent runner today; accepting the config
          // would only defer the failure to runtime, where the default
          // on_error:"ignore" swallows it. Reject it here instead.
          errors.push(
            `${label}: action.type "agent" is not supported yet — use "command" or "prompt" instead`,
          );
          break;
      }
    }

    // reject and async are mutually exclusive: async hook results cannot synchronously intercept
    if (h.reject && h.async) {
      errors.push(`${label}: reject and async are mutually exclusive`);
    }
  }

  if (errors.length > 0) {
    return new Error(errors.join("; "));
  }
  return null;
}

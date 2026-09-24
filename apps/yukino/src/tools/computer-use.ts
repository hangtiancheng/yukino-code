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

import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import sharp from "sharp";
import { safeParse, z } from "zod";

import {
  MACOS_SNIPPET,
  WINDOWS_PWSH_SNIPPET,
  WINDOWS_PWSH_INCLUDES_CSHARP_SNIPPET,
} from "./snippets.js";
import type {
  Tool,
  ToolCategory,
  ToolContext,
  ToolResult,
  ToolResultContentBlock,
  ToolSchema,
} from "./types.js";

import { maybeResizeAndDownsampleImage } from "@/images/index.js";
import { asErrorString } from "@/utils/index.js";

const ACTIONS = [
  "key",
  "hold_key",
  "type",
  "cursor_position",
  "mouse_move",
  "left_mouse_down",
  "left_mouse_up",
  "left_click",
  "left_click_drag",
  "right_click",
  "middle_click",
  "double_click",
  "triple_click",
  "scroll",
  "wait",
  "screenshot",
  "zoom",
  "click",
  "drag",
  "keypress",
  "move",
] as const;

const CoordinateSchema = z.tuple([
  z.number().int().nonnegative(),
  z.number().int().nonnegative(),
]);
const PathPointSchema = z.object({
  x: z.number().int().nonnegative(),
  y: z.number().int().nonnegative(),
});

// OpenAI computer contract: instead of one action per call, the model sends an
// ordered batch of typed actions plus safety-check/status bookkeeping.
const OPENAI_ACTION_TYPES = [
  "click",
  "double_click",
  "drag",
  "keypress",
  "move",
  "screenshot",
  "scroll",
  "type",
  "wait",
] as const;
const MAX_BATCH_ACTIONS = 100;
const OpenAIActionSchema = z.object({
  type: z.enum(OPENAI_ACTION_TYPES),
  button: z.enum(["left", "right", "wheel", "back", "forward"]).optional(),
  x: z.number().int().nonnegative().optional(),
  y: z.number().int().nonnegative().optional(),
  keys: z.array(z.string().min(1)).max(8).optional(),
  path: z.array(PathPointSchema).min(2).max(200).optional(),
  scrollX: z.number().optional(),
  scrollY: z.number().optional(),
  text: z.string().max(10_000).optional(),
});
const SafetyCheckSchema = z.object({
  id: z.string().min(1),
  code: z.string().optional(),
  message: z.string().optional(),
});
const ComputerUseInputSchema = z.object({
  action: z.enum(ACTIONS).optional(),
  actions: z.array(OpenAIActionSchema).min(1).max(MAX_BATCH_ACTIONS).optional(),
  pendingSafetyChecks: z.array(SafetyCheckSchema).optional(),
  status: z.enum(["in_progress", "completed", "incomplete"]).optional(),
  coordinate: CoordinateSchema.optional(),
  duration: z.number().nonnegative().max(60).optional(),
  region: z
    .tuple([
      z.number().int().nonnegative(),
      z.number().int().nonnegative(),
      z.number().int().nonnegative(),
      z.number().int().nonnegative(),
    ])
    .optional(),
  scroll_amount: z.number().optional(),
  scroll_direction: z.enum(["up", "down", "left", "right"]).optional(),
  start_coordinate: CoordinateSchema.optional(),
  text: z.string().max(10_000).optional(),
  x: z.number().int().nonnegative().optional(),
  y: z.number().int().nonnegative().optional(),
  button: z
    .enum(["left", "right", "wheel", "middle", "back", "forward"])
    .optional(),
  keys: z.array(z.string().min(1)).max(8).optional(),
  path: z.array(PathPointSchema).min(2).max(200).optional(),
  scroll_x: z.number().optional(),
  scroll_y: z.number().optional(),
});

type ComputerUseInput = z.infer<typeof ComputerUseInputSchema>;
type OpenAIAction = z.infer<typeof OpenAIActionSchema>;
type ComputerUseEnvironment =
  "windows" | "mac" | "browser" | "linux" | "ubuntu";
interface Point {
  x: number;
  y: number;
}
type NativeAction =
  | "cursor_position"
  | "hold_key"
  | "key"
  | "left_click_drag"
  | "left_mouse_down"
  | "left_mouse_up"
  | "mouse_click"
  | "mouse_move"
  | "scroll"
  | "type";

interface NativeInput {
  action: NativeAction;
  button?: "left" | "right" | "middle" | "back" | "forward";
  clicks?: number;
  duration?: number;
  keys?: string[];
  path?: Point[];
  scrollX?: number;
  scrollY?: number;
  text?: string;
  x?: number;
  y?: number;
}

interface CommandResult {
  code: number;
  stdout: Buffer;
  stderr: string;
}

interface CommandOptions {
  env?: NodeJS.ProcessEnv;
  maxOutputBytes?: number;
  signal?: AbortSignal;
  timeoutMs?: number;
}

type CommandRunner = (
  command: string,
  args: readonly string[],
  options?: CommandOptions,
) => Promise<CommandResult>;

export interface ComputerUseToolOptions {
  displayHeightPx?: number;
  displayNumber?: number;
  displayWidthPx?: number;
  enableZoom?: boolean;
  environment?: ComputerUseEnvironment;
  platform?: NodeJS.Platform;
  runCommand?: CommandRunner;
}

const COMMAND_TIMEOUT_MS = 15_000;
const MAX_COMMAND_OUTPUT_BYTES = 32 * 1024 * 1024;
const MAX_SCREENSHOT_WIDTH = 1366;
const MAX_SCREENSHOT_HEIGHT = 900;

function defaultEnvironment(platform: NodeJS.Platform): ComputerUseEnvironment {
  if (platform === "darwin") {
    return "mac";
  }
  if (platform === "win32") {
    return "windows";
  }
  return "linux";
}

function runCommand(
  command: string,
  args: readonly string[],
  options: CommandOptions = {},
): Promise<CommandResult> {
  const timeoutMs = options.timeoutMs ?? COMMAND_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes ?? MAX_COMMAND_OUTPUT_BYTES;

  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, [...args], {
      env: options.env ?? process.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let settled = false;
    let totalBytes = 0;
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];

    const finish = (callback: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      callback();
    };
    const fail = (message: string): void => {
      child.kill();
      finish(() => {
        rejectPromise(new Error(message));
      });
    };
    const onAbort = (): void => {
      fail(`${command} was interrupted.`);
    };
    const append = (chunk: Buffer, target: Buffer[]): void => {
      totalBytes += chunk.length;
      if (totalBytes > maxOutputBytes) {
        fail(
          `${command} exceeded the ${String(maxOutputBytes)} byte output limit.`,
        );
        return;
      }
      target.push(chunk);
    };
    const timer = setTimeout(() => {
      fail(`${command} timed out after ${String(timeoutMs)}ms.`);
    }, timeoutMs);
    timer.unref();

    child.stdout.on("data", (chunk: Buffer) => {
      append(chunk, stdout);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      append(chunk, stderr);
    });
    child.on("error", (err: NodeJS.ErrnoException) => {
      finish(() => {
        rejectPromise(
          err.code === "ENOENT"
            ? new Error(`${command} is not installed or not on PATH.`)
            : err,
        );
      });
    });
    child.on("close", (code) => {
      finish(() => {
        resolvePromise({
          code: code ?? 1,
          stdout: Buffer.concat(stdout),
          stderr: Buffer.concat(stderr).toString("utf8").trim(),
        });
      });
    });

    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) {
      onAbort();
    }
  });
}

function requiredPoint(input: ComputerUseInput): Point {
  if (input.coordinate) {
    return { x: input.coordinate[0], y: input.coordinate[1] };
  }
  if (input.x !== undefined && input.y !== undefined) {
    return { x: input.x, y: input.y };
  }
  throw new Error(
    `action=${String(input.action)} requires coordinate or x and y.`,
  );
}

function keysFor(input: ComputerUseInput): string[] {
  if (input.keys?.length) {
    return input.keys;
  }
  if (input.text) {
    return input.text
      .split("+")
      .map((key) => key.trim())
      .filter(Boolean);
  }
  return [];
}

function normalizeAction(
  input: ComputerUseInput,
):
  | NativeInput
  | "screenshot"
  | { region: number[] }
  | { action: "wait"; duration: number } {
  switch (input.action) {
    case "screenshot":
      return "screenshot";
    case "zoom": {
      if (
        !input.region ||
        input.region[2] <= input.region[0] ||
        input.region[3] <= input.region[1]
      ) {
        throw new Error(
          "action=zoom requires region [x1, y1, x2, y2] with positive area.",
        );
      }
      return { region: input.region };
    }
    case "wait":
      return { action: "wait", duration: input.duration ?? 1 };
    case "cursor_position":
      return { action: "cursor_position" };
    case "type":
      if (input.text === undefined) {
        throw new Error("action=type requires text.");
      }
      return { action: "type", text: input.text };
    case "key":
    case "keypress": {
      const keys = keysFor(input);
      if (keys.length === 0) {
        throw new Error(`action=${input.action} requires text or keys.`);
      }
      return { action: "key", keys };
    }
    case "hold_key": {
      const keys = keysFor(input);
      if (keys.length === 0 || input.duration === undefined) {
        throw new Error("action=hold_key requires text or keys and duration.");
      }
      return { action: "hold_key", keys, duration: input.duration };
    }
    case "mouse_move":
    case "move": {
      const point = requiredPoint(input);
      return { action: "mouse_move", ...point, keys: input.keys };
    }
    case "left_mouse_down":
    case "left_mouse_up":
      return { action: input.action, keys: input.keys };
    case "left_click_drag": {
      if (!input.start_coordinate) {
        throw new Error("action=left_click_drag requires start_coordinate.");
      }
      const end = requiredPoint(input);
      return {
        action: "left_click_drag",
        path: [
          { x: input.start_coordinate[0], y: input.start_coordinate[1] },
          end,
        ],
        keys: input.keys,
      };
    }
    case "drag": {
      if (!input.path) {
        throw new Error(
          "action=drag requires a path with at least two points.",
        );
      }
      return { action: "left_click_drag", path: input.path, keys: input.keys };
    }
    case "left_click":
    case "right_click":
    case "middle_click":
    case "double_click":
    case "triple_click":
    case "click": {
      const point = requiredPoint(input);
      const button =
        input.action === "right_click"
          ? "right"
          : input.action === "middle_click"
            ? "middle"
            : input.action === "click"
              ? input.button === "wheel"
                ? "middle"
                : (input.button ?? "left")
              : "left";
      const clicks =
        input.action === "double_click"
          ? 2
          : input.action === "triple_click"
            ? 3
            : 1;
      return {
        action: "mouse_click",
        button,
        clicks,
        ...point,
        keys: keysFor(input),
      };
    }
    case "scroll": {
      const point = input.coordinate
        ? { x: input.coordinate[0], y: input.coordinate[1] }
        : input.x !== undefined && input.y !== undefined
          ? { x: input.x, y: input.y }
          : {};
      if (input.scroll_x !== undefined || input.scroll_y !== undefined) {
        const toWheelClicks = (value: number): number =>
          value === 0
            ? 0
            : Math.sign(value) * Math.max(1, Math.round(Math.abs(value) / 100));
        return {
          action: "scroll",
          ...point,
          scrollX: toWheelClicks(input.scroll_x ?? 0),
          scrollY: toWheelClicks(input.scroll_y ?? 0),
          keys: keysFor(input),
        };
      }
      if (input.scroll_amount === undefined || !input.scroll_direction) {
        throw new Error(
          "action=scroll requires scroll_amount and scroll_direction, or scroll_x and scroll_y.",
        );
      }
      const amount = Math.max(1, Math.round(Math.abs(input.scroll_amount)));
      return {
        action: "scroll",
        ...point,
        scrollX:
          input.scroll_direction === "left"
            ? -amount
            : input.scroll_direction === "right"
              ? amount
              : 0,
        scrollY:
          input.scroll_direction === "up"
            ? -amount
            : input.scroll_direction === "down"
              ? amount
              : 0,
        keys: keysFor(input),
      };
    }
    default:
      throw new Error("action is required.");
  }
}

/**
 * Map one OpenAI batched action onto the flat Anthropic-style input so both
 * contracts share a single execution path.
 */
function openaiActionToFlat(item: OpenAIAction): ComputerUseInput {
  const point = {
    ...(item.x !== undefined ? { x: item.x } : {}),
    ...(item.y !== undefined ? { y: item.y } : {}),
  };
  switch (item.type) {
    case "click":
      return {
        action: "click",
        ...(item.button ? { button: item.button } : {}),
        ...point,
        keys: item.keys,
      };
    case "double_click":
      return { action: "double_click", ...point, keys: item.keys };
    case "drag":
      return { action: "drag", path: item.path, keys: item.keys };
    case "keypress":
      return { action: "keypress", keys: item.keys };
    case "move":
      return { action: "move", ...point, keys: item.keys };
    case "screenshot":
      return { action: "screenshot" };
    case "scroll":
      return {
        action: "scroll",
        ...point,
        scroll_x: item.scrollX ?? 0,
        scroll_y: item.scrollY ?? 0,
        keys: item.keys,
      };
    case "type":
      return { action: "type", text: item.text };
    case "wait":
      return { action: "wait" };
  }
}

function commandError(command: string, result: CommandResult): Error {
  return new Error(
    `${command} failed: ${result.stderr || result.stdout.toString("utf8").trim() || `exit ${String(result.code)}`}`,
  );
}

export class ComputerUseTool implements Tool {
  name = "ComputerUse";
  description: string;
  category: ToolCategory = "command";
  deferred = false;

  private readonly displayHeightPx: number;
  private readonly displayNumber?: number;
  private readonly displayWidthPx: number;
  private readonly enableZoom: boolean;
  private readonly environment: ComputerUseEnvironment;
  private readonly platform: NodeJS.Platform;
  private readonly run: CommandRunner;
  private coordinateScaleX = 1;
  private coordinateScaleY = 1;
  private macHelperPromise?: Promise<string>;

  constructor(options: ComputerUseToolOptions = {}) {
    this.displayHeightPx = options.displayHeightPx ?? MAX_SCREENSHOT_HEIGHT;
    this.displayNumber = options.displayNumber;
    this.displayWidthPx = options.displayWidthPx ?? MAX_SCREENSHOT_WIDTH;
    this.enableZoom = options.enableZoom ?? true;
    this.platform = options.platform ?? process.platform;
    this.environment = options.environment ?? defaultEnvironment(this.platform);
    this.run = options.runCommand ?? runCommand;
    this.description =
      `Control the current ${this.environment} computer with screenshots, mouse, keyboard, scrolling, waiting, and zoom. ` +
      "Use screenshot before choosing coordinates and verify consequential actions with another screenshot. " +
      "Two call styles are supported: Anthropic-style single actions (action + coordinate/scroll_amount/scroll_direction/start_coordinate/region/text), " +
      "and OpenAI-style batches (actions[] of typed actions with x/y/button/keys/path/scrollX/scrollY/text, plus pendingSafetyChecks and status; " +
      "a screenshot is returned after the batch). Flat OpenAI aliases (action=click/drag/keypress/move) are also accepted.";
  }

  isConcurrencySafe(_args: Record<string, unknown>): boolean {
    return false;
  }

  schema(): ToolSchema {
    return {
      name: this.name,
      description: this.description,
      input_schema: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ACTIONS,
            description:
              "Anthropic-style single computer action. Send either action or actions, not both.",
          },
          actions: {
            type: "array",
            items: {
              type: "object",
              properties: {
                type: {
                  type: "string",
                  enum: OPENAI_ACTION_TYPES,
                  description:
                    "OpenAI-style action type: click (button, x, y, keys), double_click (x, y, keys), drag (path, keys), keypress (keys), move (x, y, keys), screenshot, scroll (x, y, scrollX, scrollY, keys), type (text), wait.",
                },
                button: {
                  type: "string",
                  enum: ["left", "right", "wheel", "back", "forward"],
                  description: "Button for type=click.",
                },
                x: { type: "integer", minimum: 0 },
                y: { type: "integer", minimum: 0 },
                keys: {
                  type: "array",
                  items: { type: "string" },
                  maxItems: 8,
                  description:
                    "Keys held during the action, or pressed by keypress.",
                },
                path: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      x: { type: "integer", minimum: 0 },
                      y: { type: "integer", minimum: 0 },
                    },
                    required: ["x", "y"],
                    additionalProperties: false,
                  },
                  minItems: 2,
                  maxItems: 200,
                  description: "Drag path for type=drag.",
                },
                scrollX: {
                  type: "number",
                  description: "Horizontal scroll delta for type=scroll.",
                },
                scrollY: {
                  type: "number",
                  description: "Vertical scroll delta for type=scroll.",
                },
                text: {
                  type: "string",
                  description: "Text to type for type=type.",
                },
              },
              required: ["type"],
              additionalProperties: false,
            },
            minItems: 1,
            maxItems: MAX_BATCH_ACTIONS,
            description:
              "OpenAI-style ordered batch of computer actions, executed in sequence; a screenshot is returned after the batch.",
          },
          pendingSafetyChecks: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                code: { type: "string" },
                message: { type: "string" },
              },
              required: ["id"],
              additionalProperties: false,
            },
            description:
              "OpenAI-style safety checks raised with the batch; acknowledged in the tool result.",
          },
          status: {
            type: "string",
            enum: ["in_progress", "completed", "incomplete"],
            description:
              "OpenAI-style status of the computer call; echoed in the tool result.",
          },
          coordinate: {
            type: "array",
            items: { type: "integer", minimum: 0 },
            minItems: 2,
            maxItems: 2,
            description:
              "Anthropic-style [x, y] coordinate in the latest screenshot space.",
          },
          duration: {
            type: "number",
            minimum: 0,
            maximum: 60,
            description: "Seconds for hold_key or wait.",
          },
          region: {
            type: "array",
            items: { type: "integer", minimum: 0 },
            minItems: 4,
            maxItems: 4,
            description:
              "Zoom region [x1, y1, x2, y2] in the latest screenshot space.",
          },
          scroll_amount: {
            type: "number",
            description: "Anthropic-style number of wheel clicks to scroll.",
          },
          scroll_direction: {
            type: "string",
            enum: ["up", "down", "left", "right"],
          },
          start_coordinate: {
            type: "array",
            items: { type: "integer", minimum: 0 },
            minItems: 2,
            maxItems: 2,
            description: "Anthropic-style drag start coordinate.",
          },
          text: {
            type: "string",
            description: "Text to type, or a '+'-separated key combination.",
          },
          x: {
            type: "integer",
            minimum: 0,
            description: "OpenAI-style x coordinate.",
          },
          y: {
            type: "integer",
            minimum: 0,
            description: "OpenAI-style y coordinate.",
          },
          button: {
            type: "string",
            enum: ["left", "right", "wheel", "middle", "back", "forward"],
            description: "Button for action=click.",
          },
          keys: {
            type: "array",
            items: { type: "string" },
            maxItems: 8,
            description:
              "OpenAI-style keys held during an action or pressed by keypress.",
          },
          path: {
            type: "array",
            items: {
              type: "object",
              properties: {
                x: { type: "integer", minimum: 0 },
                y: { type: "integer", minimum: 0 },
              },
              required: ["x", "y"],
              additionalProperties: false,
            },
            minItems: 2,
            maxItems: 200,
            description: "OpenAI-style drag path.",
          },
          scroll_x: {
            type: "number",
            description: "OpenAI-style horizontal scroll delta.",
          },
          scroll_y: {
            type: "number",
            description: "OpenAI-style vertical scroll delta.",
          },
        },
        // Either action (Anthropic-style) or actions (OpenAI-style) is required;
        // execute() enforces the mutual exclusivity JSON Schema cannot express.
        required: [],
        additionalProperties: false,
      },
    };
  }

  async execute(
    ctx: ToolContext,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const parsed = safeParse(ComputerUseInputSchema, args);
    if (!parsed.success) {
      return {
        output: `Error: ${z.prettifyError(parsed.error)}`,
        isError: true,
      };
    }

    const input = parsed.data;
    const batch = input.actions ?? [];
    if (batch.length > 0 && input.action !== undefined) {
      return {
        output:
          "Error: send either action (Anthropic-style, one action per call) or actions (OpenAI-style batch), not both.",
        isError: true,
      };
    }
    if (batch.length === 0 && input.action === undefined) {
      return {
        output:
          "Error: action (Anthropic-style) or actions (OpenAI-style batch) is required.",
        isError: true,
      };
    }

    try {
      ctx.abortSignal?.throwIfAborted();
      if (batch.length > 0) {
        return await this.executeBatch(ctx, input);
      }
      return await this.runSingle(ctx, input);
    } catch (err) {
      return { output: `Error: ${asErrorString(err)}`, isError: true };
    }
  }

  /** Execute one Anthropic-style action (also the per-item path for batches). */
  private async runSingle(
    ctx: ToolContext,
    input: ComputerUseInput,
  ): Promise<ToolResult> {
    const action = normalizeAction(input);
    if (action === "screenshot") {
      return await this.screenshot(ctx.abortSignal);
    }
    if ("region" in action) {
      return await this.screenshot(ctx.abortSignal, action.region);
    }
    if (action.action === "wait") {
      await delay((action.duration ?? 1) * 1000, undefined, {
        signal: ctx.abortSignal,
      });
      return { output: "Wait completed.", isError: false };
    }

    const native = this.toNativeCoordinates(action);
    let output = await this.executeNative(native, ctx.abortSignal);
    if (native.action === "cursor_position" && output) {
      const [x, y] = output.split(",").map(Number);
      if (Number.isFinite(x) && Number.isFinite(y)) {
        output = `${String(Math.round(x / this.coordinateScaleX))},${String(Math.round(y / this.coordinateScaleY))}`;
      }
    }
    return {
      output: output || `Computer action ${input.action ?? "batch"} completed.`,
      isError: false,
    };
  }

  /**
   * Execute an OpenAI-style ordered action batch. Per the OpenAI computer
   * output contract, the result always carries the screenshot taken after the
   * batch ran, and status / safety checks are echoed so the model can continue.
   */
  private async executeBatch(
    ctx: ToolContext,
    input: ComputerUseInput,
  ): Promise<ToolResult> {
    const actions = input.actions ?? [];
    const executed: string[] = [];
    let screenshotResult: ToolResult | undefined;
    for (const [index, item] of actions.entries()) {
      ctx.abortSignal?.throwIfAborted();
      let result: ToolResult;
      try {
        result = await this.runSingle(ctx, openaiActionToFlat(item));
      } catch (err) {
        return {
          output: `Error at actions[${String(index)}] (${item.type}): ${asErrorString(err)}`,
          isError: true,
        };
      }
      if (result.isError) {
        return {
          output: `Error at actions[${String(index)}] (${item.type}): ${result.output}`,
          contentBlocks: result.contentBlocks,
          isError: true,
        };
      }
      executed.push(item.type);
      if (item.type === "screenshot") {
        screenshotResult = result;
      }
    }

    screenshotResult ??= await this.screenshot(ctx.abortSignal).catch(
      (err: unknown): ToolResult => ({
        output: `Actions completed, but the follow-up screenshot failed: ${asErrorString(err)}`,
        isError: false,
      }),
    );

    const notes = [
      input.status ? `Status: ${input.status}.` : "",
      input.pendingSafetyChecks?.length
        ? `Acknowledged safety checks: ${input.pendingSafetyChecks.map((check) => check.id).join(", ")}.`
        : "",
    ]
      .filter(Boolean)
      .join(" ");
    return {
      output: `${screenshotResult.output} Executed ${String(executed.length)} action(s): ${executed.join(", ")}.${notes ? ` ${notes}` : ""}`,
      contentBlocks: screenshotResult.contentBlocks,
      isError: false,
    };
  }

  private toNativeCoordinates(action: NativeInput): NativeInput {
    const scalePoint = (point: Point): Point => ({
      x: Math.round(point.x * this.coordinateScaleX),
      y: Math.round(point.y * this.coordinateScaleY),
    });
    return {
      ...action,
      ...(action.x !== undefined && action.y !== undefined
        ? scalePoint({ x: action.x, y: action.y })
        : {}),
      ...(action.path ? { path: action.path.map(scalePoint) } : {}),
    };
  }

  private async executeNative(
    action: NativeInput,
    signal?: AbortSignal,
  ): Promise<string> {
    switch (this.platform) {
      case "darwin":
        return this.executeMac(action, signal);
      case "win32":
        return this.executeWindows(action, signal);
      case "linux":
        return this.executeLinux(action, signal);
      default:
        throw new Error(`ComputerUse is not supported on ${this.platform}.`);
    }
  }

  private async executeMac(
    action: NativeInput,
    signal?: AbortSignal,
  ): Promise<string> {
    return this.runMacPayload(
      action,
      signal,
      action.action === "hold_key"
        ? Math.max(COMMAND_TIMEOUT_MS, (action.duration ?? 0) * 1000 + 5_000)
        : COMMAND_TIMEOUT_MS,
    );
  }

  private async runMacPayload(
    payload: object,
    signal?: AbortSignal,
    timeoutMs = COMMAND_TIMEOUT_MS,
  ): Promise<string> {
    const helper = await this.getMacHelper(signal);
    const result = await this.run(helper, [], {
      env: {
        ...process.env,
        YUKINO_COMPUTER_INPUT: Buffer.from(JSON.stringify(payload)).toString(
          "base64",
        ),
      },
      signal,
      timeoutMs,
    });
    if (result.code !== 0) {
      throw commandError("macOS computer helper", result);
    }
    return result.stdout.toString("utf8").trim();
  }

  private async getMacHelper(signal?: AbortSignal): Promise<string> {
    this.macHelperPromise ??= this.compileMacHelper(signal);
    try {
      return await this.macHelperPromise;
    } catch (err) {
      this.macHelperPromise = undefined;
      throw err;
    }
  }

  private async compileMacHelper(signal?: AbortSignal): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), "yukino-computer-helper-"));
    const sourcePath = join(directory, "main.swift");
    const executablePath = join(directory, "computer-helper");
    try {
      await writeFile(sourcePath, MACOS_SNIPPET, "utf8");
      const result = await this.run(
        "/usr/bin/xcrun",
        ["swiftc", "-O", sourcePath, "-o", executablePath],
        { signal, timeoutMs: 120_000 },
      );
      if (result.code !== 0) {
        throw commandError("swiftc", result);
      }
      return executablePath;
    } catch (err) {
      await rm(directory, { recursive: true, force: true });
      throw err;
    }
  }

  private async executeWindows(
    action: NativeInput,
    signal?: AbortSignal,
  ): Promise<string> {
    const result = await this.run(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Sta",
        "-Command",
        WINDOWS_PWSH_INCLUDES_CSHARP_SNIPPET,
      ],
      {
        env: {
          ...process.env,
          YUKINO_COMPUTER_INPUT: Buffer.from(JSON.stringify(action)).toString(
            "base64",
          ),
        },
        signal,
        timeoutMs:
          action.action === "hold_key"
            ? Math.max(
                COMMAND_TIMEOUT_MS,
                (action.duration ?? 0) * 1000 + 5_000,
              )
            : COMMAND_TIMEOUT_MS,
      },
    );
    if (result.code !== 0) {
      throw commandError("powershell.exe", result);
    }
    return result.stdout.toString("utf8").trim();
  }

  private async executeLinux(
    action: NativeInput,
    signal?: AbortSignal,
  ): Promise<string> {
    const runXdotool = async (args: readonly string[]): Promise<string> => {
      const result = await this.run("xdotool", args, { signal });
      if (result.code !== 0) {
        throw commandError("xdotool", result);
      }
      return result.stdout.toString("utf8").trim();
    };
    const keys = action.keys ?? [];
    const keyDown = async (): Promise<void> => {
      for (const key of keys) {
        await runXdotool(["keydown", key]);
      }
    };
    const keyUp = async (): Promise<void> => {
      for (const key of [...keys].reverse()) {
        await runXdotool(["keyup", key]);
      }
    };
    const withKeys = async (operation: () => Promise<void>): Promise<void> => {
      await keyDown();
      try {
        await operation();
      } finally {
        await keyUp();
      }
    };
    const move = async (): Promise<void> => {
      if (action.x !== undefined && action.y !== undefined) {
        await runXdotool([
          "mousemove",
          "--sync",
          String(action.x),
          String(action.y),
        ]);
      }
    };

    switch (action.action) {
      case "cursor_position": {
        const output = await runXdotool(["getmouselocation", "--shell"]);
        const x = /(?:^|\n)X=(\d+)/.exec(output)?.[1];
        const y = /(?:^|\n)Y=(\d+)/.exec(output)?.[1];
        if (!x || !y) {
          throw new Error(`Unable to parse cursor position: ${output}`);
        }
        return `${x},${y}`;
      }
      case "mouse_move":
        await withKeys(move);
        return "";
      case "left_mouse_down":
        await runXdotool(["mousedown", "1"]);
        return "";
      case "left_mouse_up":
        await runXdotool(["mouseup", "1"]);
        return "";
      case "mouse_click": {
        await move();
        const button =
          action.button === "right"
            ? 3
            : action.button === "middle"
              ? 2
              : action.button === "back"
                ? 8
                : action.button === "forward"
                  ? 9
                  : 1;
        await withKeys(async () => {
          await runXdotool([
            "click",
            "--repeat",
            String(action.clicks ?? 1),
            "--delay",
            "80",
            String(button),
          ]);
        });
        return "";
      }
      case "left_click_drag": {
        const path = action.path ?? [];
        if (path.length < 2) {
          throw new Error("Drag path must contain at least two points.");
        }
        await withKeys(async () => {
          await runXdotool([
            "mousemove",
            "--sync",
            String(path[0].x),
            String(path[0].y),
          ]);
          await runXdotool(["mousedown", "1"]);
          try {
            for (const point of path.slice(1)) {
              await runXdotool([
                "mousemove",
                "--sync",
                String(point.x),
                String(point.y),
              ]);
            }
          } finally {
            await runXdotool(["mouseup", "1"]);
          }
        });
        return "";
      }
      case "scroll": {
        await move();
        await withKeys(async () => {
          const clicks: [number, number][] = [
            [action.scrollY ?? 0, (action.scrollY ?? 0) < 0 ? 4 : 5],
            [action.scrollX ?? 0, (action.scrollX ?? 0) < 0 ? 6 : 7],
          ];
          for (const [amount, button] of clicks) {
            if (amount !== 0) {
              await runXdotool([
                "click",
                "--repeat",
                String(Math.abs(amount)),
                String(button),
              ]);
            }
          }
        });
        return "";
      }
      case "key":
        await runXdotool(["key", keys.join("+")]);
        return "";
      case "hold_key":
        await keyDown();
        try {
          await delay((action.duration ?? 0) * 1000, undefined, { signal });
        } finally {
          await keyUp();
        }
        return "";
      case "type":
        await runXdotool(["type", "--delay", "1", "--", action.text ?? ""]);
        return "";
    }
  }

  private async screenshot(
    signal?: AbortSignal,
    region?: number[],
  ): Promise<ToolResult> {
    const capture = await this.captureScreenshot(signal);
    const metadata = await sharp(capture.bytes).metadata();
    if (!metadata.width || !metadata.height) {
      throw new Error("Unable to determine screenshot dimensions.");
    }

    if (region) {
      const left = Math.round(region[0] * this.coordinateScaleX);
      const top = Math.round(region[1] * this.coordinateScaleY);
      const right = Math.round(region[2] * this.coordinateScaleX);
      const bottom = Math.round(region[3] * this.coordinateScaleY);
      const rawScaleX = metadata.width / capture.width;
      const rawScaleY = metadata.height / capture.height;
      const rawLeft = Math.max(
        0,
        Math.min(metadata.width - 1, Math.round(left * rawScaleX)),
      );
      const rawTop = Math.max(
        0,
        Math.min(metadata.height - 1, Math.round(top * rawScaleY)),
      );
      const rawRight = Math.max(
        rawLeft + 1,
        Math.min(metadata.width, Math.round(right * rawScaleX)),
      );
      const rawBottom = Math.max(
        rawTop + 1,
        Math.min(metadata.height, Math.round(bottom * rawScaleY)),
      );
      const cropped = await sharp(capture.bytes)
        .extract({
          left: rawLeft,
          top: rawTop,
          width: rawRight - rawLeft,
          height: rawBottom - rawTop,
        })
        .png({ compressionLevel: 8 })
        .toBuffer();
      return this.imageResult(
        cropped,
        `Zoomed screenshot of [${region.join(", ")}].`,
      );
    }

    const targetScale = Math.min(
      1,
      MAX_SCREENSHOT_WIDTH / capture.width,
      MAX_SCREENSHOT_HEIGHT / capture.height,
    );
    const targetWidth = Math.max(1, Math.round(capture.width * targetScale));
    const targetHeight = Math.max(1, Math.round(capture.height * targetScale));
    const normalized = await sharp(capture.bytes)
      .resize(targetWidth, targetHeight, { fit: "fill" })
      .png({ compressionLevel: 8 })
      .toBuffer();
    const result = await this.imageResult(
      normalized,
      `Screenshot ${String(targetWidth)}x${String(targetHeight)}. Use this coordinate space for subsequent actions.`,
    );
    const outputBlock = result.contentBlocks?.[0];
    if (outputBlock?.type === "image" && outputBlock.source.type === "base64") {
      const finalMetadata = await sharp(
        Buffer.from(outputBlock.source.data, "base64"),
      ).metadata();
      if (finalMetadata.width && finalMetadata.height) {
        this.coordinateScaleX = capture.width / finalMetadata.width;
        this.coordinateScaleY = capture.height / finalMetadata.height;
        result.output = `Screenshot ${String(finalMetadata.width)}x${String(finalMetadata.height)}. Use this coordinate space for subsequent actions.`;
      }
    }
    return result;
  }

  private async imageResult(
    bytes: Buffer,
    output: string,
  ): Promise<ToolResult> {
    const image = await maybeResizeAndDownsampleImage(bytes, "image/png");
    const imageBlock = {
      type: "image",
      source: {
        type: "base64",
        media_type: image.mediaType,
        data: image.data,
      },
    } satisfies ToolResultContentBlock;
    return { output, contentBlocks: [imageBlock], isError: false };
  }

  private async captureScreenshot(
    signal?: AbortSignal,
  ): Promise<{ bytes: Buffer; width: number; height: number }> {
    const directory = await mkdtemp(join(tmpdir(), "yukino-computer-"));
    const screenshotPath = join(directory, "screenshot.png");
    try {
      switch (this.platform) {
        case "darwin": {
          const capture = await this.run(
            "/usr/sbin/screencapture",
            ["-x", "-m", "-t", "png", screenshotPath],
            { signal },
          );
          if (capture.code !== 0) {
            throw commandError("screencapture", capture);
          }
          const size = await this.runMacPayload(
            { action: "screen_size" },
            signal,
          ).catch(() => "");
          const [width, height] = size.split(",").map(Number);
          const bytes = await readFile(screenshotPath);
          const metadata = await sharp(bytes).metadata();
          return {
            bytes,
            width:
              Number.isFinite(width) && width > 0
                ? width
                : (metadata.width ?? 1),
            height:
              Number.isFinite(height) && height > 0
                ? height
                : (metadata.height ?? 1),
          };
        }
        case "win32": {
          const capture = await this.run(
            "powershell.exe",
            [
              "-NoProfile",
              "-NonInteractive",
              "-Sta",
              "-Command",
              WINDOWS_PWSH_SNIPPET,
            ],
            {
              env: { ...process.env, YUKINO_SCREENSHOT_PATH: screenshotPath },
              signal,
            },
          );
          if (capture.code !== 0) {
            throw commandError("powershell.exe", capture);
          }
          const [width, height] = capture.stdout
            .toString("utf8")
            .trim()
            .split(",")
            .map(Number);
          return { bytes: await readFile(screenshotPath), width, height };
        }
        case "linux": {
          const backends: [string, string[]][] = [
            ["gnome-screenshot", ["-f", screenshotPath]],
            ["scrot", [screenshotPath]],
            ["import", ["-window", "root", screenshotPath]],
          ];
          let lastError = "No screenshot backend succeeded.";
          for (const [command, args] of backends) {
            try {
              const capture = await this.run(command, args, { signal });
              if (capture.code === 0) {
                const bytes = await readFile(screenshotPath);
                const metadata = await sharp(bytes).metadata();
                return {
                  bytes,
                  width: metadata.width ?? 1,
                  height: metadata.height ?? 1,
                };
              }
              lastError = commandError(command, capture).message;
            } catch (err) {
              lastError = asErrorString(err);
            }
          }
          throw new Error(
            `${lastError} Install gnome-screenshot, scrot, or ImageMagick; xdotool is required for input control.`,
          );
        }
        default:
          throw new Error(`ComputerUse is not supported on ${this.platform}.`);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}

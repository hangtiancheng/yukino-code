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

import type { Tool, ToolCategory, ToolContext, ToolResult, ToolSchema } from "./types.js";

export class ExitPlanModeTool implements Tool {
  // Use a hardcoded string instead of ExitPlanModeTool.name.replace("Tool", "")
  // because class names are not stable after minification — bundlers like
  // Terser/esbuild may rename or mangle them, producing incorrect tool names at runtime.
  name = "ExitPlanMode";
  description = `
  Exit plan mode and present the plan for user approval.
  Call this when your plan is complete and written to the plan file.
  `;
  category: ToolCategory = "read";

  isPlanMode: (() => boolean) | null = null;
  planExists: (() => boolean) | null = null;
  schema(): ToolSchema {
    const inputSchema = {
      type: "object" as const,
      properties: {},
    };

    return {
      name: this.name,
      description: this.description,
      input_schema: inputSchema,
    };
  }

  execute(_ctx: ToolContext, _args: Record<string, unknown>): Promise<ToolResult> {
    if (this.isPlanMode && !this.isPlanMode()) {
      if (this.planExists?.()) {
        return Promise.resolve({
          output:
            "You are not in plan mode. This tool is only for exiting plan mode after writing a plan. You can call AskUserQuestion tool to ask the user whether to execute the plan.",
          isError: true,
        });
      }
      return Promise.resolve({
        output:
          "You are not in plan mode. This tool is only for exiting plan mode after writing a plan.",
        isError: true,
      });
    }

    if (this.planExists && !this.planExists()) {
      return Promise.resolve({
        output:
          "No plan file found. Please write your plan to the plan file before calling ExitPlanMode.",
        isError: true,
      });
    }

    return Promise.resolve({
      output:
        "Plan mode will be exited after this turn. The user will be shown the plan approval dialog. Do not call any more tools — end your turn now.",
      isError: false,
    });
  }
}

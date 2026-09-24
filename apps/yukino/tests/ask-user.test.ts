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

import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, it, expect } from "vitest";

import { AskUserQuestionTool, type Question } from "@/tools/ask-user.js";
import type { ToolContext } from "@/tools/types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const toolContext: ToolContext = {
  workDir: __dirname,
};

function q(overrides: Partial<Question> = {}): Question {
  return {
    question: "Pick one",
    header: "Choice",
    options: [
      { label: "A", description: "Option A" },
      { label: "B", description: "Option B" },
    ],
    multiSelect: false,
    ...overrides,
  };
}

describe("AskUserQuestionTool", () => {
  it("rejects 0 or more than 4 questions", async () => {
    // eslint-disable-next-line @typescript-eslint/require-await
    const tool = new AskUserQuestionTool(async () => ({}));
    expect((await tool.execute(toolContext, { questions: [] })).isError).toBe(
      true,
    );
    expect(
      (
        await tool.execute(toolContext, {
          questions: [q(), q(), q(), q(), q()],
        })
      ).isError,
    ).toBe(true);
  });

  it("rejects a question with fewer than 2 or more than 4 options", async () => {
    // eslint-disable-next-line @typescript-eslint/require-await
    const tool = new AskUserQuestionTool(async () => ({}));
    const tooFew = await tool.execute(
      toolContext,

      {
        questions: [q({ options: [{ label: "only", description: "only" }] })],
      },
    );
    expect(tooFew.isError).toBe(true);
    const tooMany = await tool.execute(toolContext, {
      questions: [
        q({
          options: [
            { label: "1", description: "one" },
            { label: "2", description: "two" },
            { label: "3", description: "three" },
            { label: "4", description: "four" },
            { label: "5", description: "five" },
          ],
        }),
      ],
    });
    expect(tooMany.isError).toBe(true);
  });

  it("delegates to the asker and formats the answers", async () => {
    // eslint-disable-next-line @typescript-eslint/require-await
    const tool = new AskUserQuestionTool(async (qs) => ({
      [qs[0].question]: "A",
    }));
    const r = await tool.execute(toolContext, { questions: [q()] });
    expect(r.isError).toBe(false);
    expect(r.output).toContain('"Pick one" = "A"');
    expect(r.output).toContain("continue");
  });
});

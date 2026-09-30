import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

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
    const tool = new AskUserQuestionTool(() => Promise.resolve({}));
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
    const tool = new AskUserQuestionTool(() => Promise.resolve({}));
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

  it("enforces the 12-character header contract in schema and runtime", async () => {
    const asker = vi.fn(() => Promise.resolve({}));
    const tool = new AskUserQuestionTool(asker);

    expect(tool.schema().input_schema).toMatchObject({
      properties: {
        questions: {
          items: {
            properties: { header: { maxLength: 12 } },
          },
        },
      },
    });
    expect(
      (
        await tool.execute(toolContext, {
          questions: [q({ header: "1234567890123" })],
        })
      ).isError,
    ).toBe(true);
    expect(asker).not.toHaveBeenCalled();
  });

  it("delegates to the asker and formats the answers", async () => {
    const tool = new AskUserQuestionTool((qs) =>
      Promise.resolve({ [qs[0].question]: "A" }),
    );
    const r = await tool.execute(toolContext, { questions: [q()] });
    expect(r.isError).toBe(false);
    expect(r.output).toContain('"Pick one" = "A"');
    expect(r.output).toContain("continue");
  });
});

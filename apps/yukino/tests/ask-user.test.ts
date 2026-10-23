import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";
import z from "zod";

import {
  AskUserQuestionTool,
  type Question,
} from "@yukino.js/tools/ask-user.js";
import type { ToolContext } from "@yukino.js/tools/types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const toolContext: ToolContext = {
  cwd: __dirname,
};

function q(overrides: Partial<Question> = {}): Question {
  return {
    question: "Pick one",
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

  it("exposes only supported question fields and rejects unknown fields before asking", async () => {
    const asker = vi.fn(() => Promise.resolve({}));
    const tool = new AskUserQuestionTool(asker);

    const schema = z
      .object({
        items: z.object({ properties: z.record(z.string(), z.unknown()) }),
      })
      .parse(tool.schema().input_schema.properties.questions);
    expect(Object.keys(schema.items.properties)).toEqual([
      "question",
      "options",
      "multiSelect",
    ]);
    expect(tool.schema().input_schema).toHaveProperty(
      "properties.questions.items.required",
      ["question", "options", "multiSelect"],
    );
    expect(tool.schema().input_schema).toHaveProperty(
      "properties.questions.items.additionalProperties",
      false,
    );
    expect(
      (
        await tool.execute(toolContext, {
          questions: [{ ...q(), unknownField: "unsupported" }],
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

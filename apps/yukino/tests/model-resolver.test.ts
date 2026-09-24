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

import { describe, it, expect } from "vitest";

import { resolveModelId } from "@/llm/model-resolver.js";
import { BUILTIN_AGENTS } from "@/subagent/definition.js";

describe("model alias resolution", () => {
  it("resolves short aliases to full model ids", () => {
    expect(resolveModelId("haiku")).toBe("claude-haiku-4-6");
    expect(resolveModelId("sonnet")).toContain("sonnet");
    expect(resolveModelId("opus")).toContain("opus");
  });

  it("passes through an unknown / already-full model id unchanged", () => {
    expect(resolveModelId("claude-some-future-model")).toBe(
      "claude-some-future-model",
    );
  });

  it("the explore builtin runs on the cheaper haiku model", () => {
    const explore = BUILTIN_AGENTS.find((a) => a.name === "explore");
    expect(explore?.model).toBe("haiku");
  });
});

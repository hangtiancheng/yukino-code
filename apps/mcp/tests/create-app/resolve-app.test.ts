import { describe, expect, it } from "vitest";

import { resolveAppDocument } from "@/tools/create-app/resolve-app.js";

const FALLBACK_TITLE = "MCP App";

describe("resolveAppDocument", () => {
  it("prefers HTML carried in the tool result meta", () => {
    expect(
      resolveAppDocument({
        resultMeta: { html: "<p>from meta</p>", title: "Meta" },
        inputHtml: "<p>from input</p>",
        inputTitle: "Input",
        fallbackTitle: FALLBACK_TITLE,
      }),
    ).toEqual({ html: "<p>from meta</p>", title: "Meta" });
  });

  it("keeps the tool input document when the host omits result meta", () => {
    expect(
      resolveAppDocument({
        structuredContent: { title: "Greeting" },
        inputHtml: "<p>hello</p>",
        inputTitle: "Greeting",
        fallbackTitle: FALLBACK_TITLE,
      }),
    ).toEqual({ html: "<p>hello</p>", title: "Greeting" });
  });

  it("reads HTML from structured content when meta is absent", () => {
    expect(
      resolveAppDocument({
        structuredContent: { html: "<p>structured</p>", title: "Structured" },
        fallbackTitle: FALLBACK_TITLE,
      }),
    ).toEqual({ html: "<p>structured</p>", title: "Structured" });
  });

  it("returns undefined when neither the result nor the input has HTML", () => {
    expect(
      resolveAppDocument({
        structuredContent: { title: "Greeting" },
        fallbackTitle: FALLBACK_TITLE,
      }),
    ).toBeUndefined();
  });
});

import { load } from "cheerio";
import type { ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { ToolItem } from "#/types.js";
import { DARK_THEME, LIGHT_THEME } from "@/theme/constants.js";

// Browser components are typechecked separately, without adding DOM globals to Node.
const { ToolBlock } = await vi.importActual<{
  ToolBlock: ComponentType<{ item: ToolItem }>;
}>("#/components/tool-block.js");

describe("browser tool state colors", () => {
  it.each(["dark", "light"] as const)(
    "uses distinct %s state surfaces without losing tool output",
    (mode) => {
      const palette = mode === "dark" ? DARK_THEME : LIGHT_THEME;
      const backgrounds: string[] = [];
      for (const [status, backgroundClass, background] of [
        ["running", "bg-tool-pending", palette.toolPendingBg],
        ["ok", "bg-tool-success", palette.toolSuccessBg],
        ["err", "bg-tool-error", palette.toolErrorBg],
      ] as const) {
        const $ = load(
          renderToStaticMarkup(
            <ToolBlock
              item={{
                kind: "tool",
                id: "tool-state",
                toolId: "tool-state",
                toolName: "ReadFile",
                args: { file_path: "example.ts" },
                status,
                output: "Tool output",
                isError: status === "err",
                elapsed: 0.5,
              }}
            />,
          ),
        );
        expect($(".tool-card").hasClass(backgroundClass)).toBe(true);
        expect($(".tool-card").text()).toContain("ReadFile");
        expect($(".tool-card").text()).toContain("Tool output");
        expect($(".tool-card > button").attr("aria-expanded")).toBe("false");
        backgrounds.push(background);
      }
      expect(new Set(backgrounds).size).toBe(3);
    },
  );
});

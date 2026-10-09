import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { append, load, MAX_HISTORY_ENTRIES } from "@/history/index.js";
import { getYukinoDir } from "@/storage/paths.js";

describe("prompt history", () => {
  it("retains 10,000 prompts and evicts the oldest entry on overflow", () => {
    const dir = getYukinoDir();
    mkdirSync(dir, { recursive: true });
    const filePath = join(dir, "prompt_history.jsonl");
    const entries = Array.from({ length: 10_000 }, (_, index) =>
      JSON.stringify({ text: `prompt-${String(index)}` }),
    );
    writeFileSync(filePath, entries.join("\n") + "\n", "utf-8");

    const retained = append("prompt-10000");

    expect(retained).toHaveLength(10_000);
    expect(retained[0]).toBe("prompt-1");
    expect(retained.at(-1)).toBe("prompt-10000");
    expect(load()).toEqual(retained);
    expect(readFileSync(filePath, "utf-8").trim().split("\n")).toHaveLength(
      10_000,
    );
  });

  it("filters malformed and empty entries while loading", () => {
    const dir = getYukinoDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "prompt_history.jsonl"),
      ['{"text":"first"}', "not-json", '{"text":""}', '{"text":"last"}'].join(
        "\n",
      ),
      "utf-8",
    );

    expect(load()).toEqual(["first", "last"]);
  });

  it("deduplicates the latest prompt and trims oversized history files", () => {
    const dir = getYukinoDir();
    mkdirSync(dir, { recursive: true });
    const filePath = join(dir, "prompt_history.jsonl");
    const entries = Array.from(
      { length: MAX_HISTORY_ENTRIES + 50 },
      (_, index) => JSON.stringify({ text: `prompt-${String(index)}` }),
    );
    writeFileSync(filePath, entries.join("\n") + "\n", "utf-8");
    const latestPrompt = `prompt-${String(MAX_HISTORY_ENTRIES + 49)}`;

    const loaded = load();
    expect(loaded).toHaveLength(MAX_HISTORY_ENTRIES);
    expect(loaded[0]).toBe("prompt-50");

    const retained = append(latestPrompt);

    expect(retained).toHaveLength(MAX_HISTORY_ENTRIES);
    expect(retained).toEqual(loaded);
    expect(retained.at(-1)).toBe(latestPrompt);
    expect(readFileSync(filePath, "utf-8").trim().split("\n")).toHaveLength(
      MAX_HISTORY_ENTRIES,
    );
  });
});

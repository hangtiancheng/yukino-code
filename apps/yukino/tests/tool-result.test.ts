import { mkdtempSync as createTempDir, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { afterEach, describe, it, expect } from "vitest";

import type { ToolResultBlock } from "@/conversation/index.js";
import { sessionPath } from "@/storage/paths.js";
import {
  applyBudget,
  buildPersistedOutputPreview,
  isSpillReadback,
  persistLargeResult,
} from "@/tool-result/index.js";

const tempDirs = new Set<string>();

function mkdtempSync(prefix: string): string {
  const directory = createTempDir(prefix);
  tempDirs.add(directory);
  return directory;
}

afterEach(() => {
  for (const directory of tempDirs) {
    rmSync(directory, { recursive: true, force: true });
  }
  tempDirs.clear();
});
function batch(...sizes: number[]): ToolResultBlock[] {
  return sizes.map((n, i) => ({
    toolUseId: `t${String(i + 1)}`,
    content: "x".repeat(n),
    isError: false,
  }));
}

function totalLen(rs: ToolResultBlock[]): number {
  return rs.reduce((sum, r) => sum + r.content.length, 0);
}

describe("tool result budget", () => {
  it("leaves an under-limit batch untouched", () => {
    const rs = batch(40000, 40000);

    applyBudget(rs, "s");

    expect(rs[0].content).toBe("x".repeat(40000));
    expect(rs[1].content).toBe("x".repeat(40000));
  });

  it("spills the largest results until aggregate is within limit", () => {
    // 5 results totaling 225K+1; spilling only the largest, t3, is enough to get back within the limit
    const rs = batch(45000, 45000, 45001, 45000, 45000);

    applyBudget(rs, "s");

    expect(totalLen(rs)).toBeLessThanOrEqual(200000);
    const replaced = rs.filter((result) =>
      result.content.includes("<persisted-output>"),
    );
    expect(replaced.length).toBe(1);
    expect(rs[2].content).toContain("<persisted-output>");
    const spilled = readFileSync(
      sessionPath("s", "tool-results", "t3.txt"),
      "utf-8",
    );
    expect(spilled.length).toBe(45001);
  });

  it("skips exempt ids and spills the next largest instead", () => {
    const rs = batch(45000, 45000, 45001, 45000, 45000);

    applyBudget(rs, "s", new Set(["t3"]));

    expect(rs[2].content).toBe("x".repeat(45001));
    expect(totalLen(rs)).toBeLessThanOrEqual(200000);
  });

  it("accepts overage when everything is exempt", () => {
    const rs = batch(105000, 105000);

    applyBudget(rs, "s", new Set(["t1", "t2"]));

    expect(rs[0].content).toBe("x".repeat(105000));
    expect(rs[1].content).toBe("x".repeat(105000));
  });

  it("produces byte-identical output for identical input", () => {
    const rs1 = batch(45000, 45000, 45001, 45000, 45000);
    const rs2 = batch(45000, 45000, 45001, 45000, 45000);

    applyBudget(rs1, "s");
    applyBudget(rs2, "s");

    for (let i = 0; i < rs1.length; i++) {
      expect(rs2[i].content).toBe(rs1[i].content);
    }
  });

  it("is a no-op on an already-processed batch", () => {
    const rs = batch(45000, 45000, 45001, 45000, 45000);
    applyBudget(rs, "s");
    const snapshot = rs.map((r) => r.content);

    applyBudget(rs, "s");

    expect(rs.map((r) => r.content)).toEqual(snapshot);
  });

  it("spills rich text while preserving non-text blocks", () => {
    const result: ToolResultBlock = {
      toolUseId: "rich",
      content: "x".repeat(250_000),
      contentBlocks: [
        { type: "text", text: "x".repeat(250_000) },
        {
          type: "image",
          source: { type: "base64", media_type: "image/png", data: "QUJD" },
        },
      ],
      isError: false,
    };

    applyBudget([result], "s");

    expect(result.content).toContain("<persisted-output>");
    expect(result.contentBlocks?.[0]).toEqual({
      type: "text",
      text: result.content,
    });
    expect(result.contentBlocks?.[1]?.type).toBe("image");
    expect(
      readFileSync(sessionPath("s", "tool-results", "rich.txt"), "utf-8"),
    ).toHaveLength(250_000);
  });

  it("detects spill readbacks", () => {
    const cwd = mkdtempSync(join(tmpdir(), "yukino-tr-"));
    const inside = sessionPath("s", "tool-results", "toolu_abc.txt");
    const outside = join(cwd, "main.ts");

    expect(isSpillReadback("ReadFile", { file_path: inside }, cwd, "s")).toBe(
      true,
    );
    expect(isSpillReadback("ReadFile", { file_path: outside }, cwd, "s")).toBe(
      false,
    );
    expect(isSpillReadback("Bash", { file_path: inside }, cwd, "s")).toBe(
      false,
    );
    expect(isSpillReadback("ReadFile", {}, cwd, "s")).toBe(false);
    expect(
      isSpillReadback(
        "ReadFile",
        {
          file_path: relative(
            cwd,
            sessionPath("s", "tool-results", "relative.txt"),
          ),
        },
        cwd,
        "s",
      ),
    ).toBe(true);
    expect(
      isSpillReadback(
        "ReadFile",
        {
          file_path: sessionPath("s", "tool-results-extra", "sibling.txt"),
        },
        cwd,
        "s",
      ),
    ).toBe(false);
  });

  it("labels in-memory persisted previews in characters", () => {
    const preview = buildPersistedOutputPreview(
      3000,
      "あ".repeat(2000),
      "/tmp/output",
    );

    expect(preview).toContain("Output too large (3000 characters)");
    expect(preview).toContain("Preview (first 2000 characters)");
    expect(preview).not.toContain("9000 bytes");
  });

  it("persistLargeResult round-trips deterministically", () => {
    const content = "y".repeat(60000);

    const preview = persistLargeResult("s", "t_big", content);

    expect(preview).toContain("<persisted-output>");
    expect(preview).toContain("saved to");
    const spilled = readFileSync(
      sessionPath("s", "tool-results", "t_big.txt"),
      "utf-8",
    );
    expect(spilled.length).toBe(60000);
    // A second call (the file already exists) returns a byte-identical preview
    expect(persistLargeResult("s", "t_big", content)).toBe(preview);
  });
});

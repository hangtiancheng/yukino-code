import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, it, expect } from "vitest";

import { fileHistoryDir } from "@/file-history/index.js";
import {
  clipboardImageFileName,
  isPngBuffer,
  storeClipboardImage,
} from "@/images/clipboard.js";

const PNG_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from("fake png body"),
]);

describe("clipboard image storage", () => {
  it("detects PNG buffers by signature", () => {
    expect(isPngBuffer(PNG_BYTES)).toBe(true);
    expect(isPngBuffer(Buffer.from("plain text"))).toBe(false);
    expect(isPngBuffer(Buffer.alloc(0))).toBe(false);
  });

  it("names files with the file-history sha256 prefix scheme", () => {
    const expected = createHash("sha256")
      .update(PNG_BYTES)
      .digest("hex")
      .slice(0, 16);
    expect(clipboardImageFileName(PNG_BYTES)).toBe(`${expected}.png`);
  });

  it("writes the image into the session's file-history dir and dedupes repeats", async () => {
    const workDir = mkdtempSync(join(tmpdir(), "yukino-clip-"));

    const first = await storeClipboardImage(workDir, "session-a", PNG_BYTES);
    const second = await storeClipboardImage(workDir, "session-a", PNG_BYTES);

    expect(first).toBe(second);
    expect(dirname(first)).toBe(fileHistoryDir(workDir, "session-a"));
    expect(dirname(first)).toBe(
      join(workDir, ".yukino", "file-history", "session-a"),
    );
    expect(first.endsWith(".png")).toBe(true);
    expect(readFileSync(first)).toEqual(PNG_BYTES);
  });

  it("rejects non-PNG bytes", async () => {
    const workDir = mkdtempSync(join(tmpdir(), "yukino-clip-"));
    await expect(
      storeClipboardImage(workDir, "session-a", Buffer.from("GIF89a")),
    ).rejects.toThrow(/not a PNG/);
  });
});

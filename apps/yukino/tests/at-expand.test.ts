import {
  copyFileSync,
  mkdtempSync as createTempDir,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, it, expect } from "vitest";

import {
  expandAtRefs,
  expandAtRefsWithImages,
} from "@/conversation/at-expand.js";
import { collapseImage, expandPastes } from "@/ui/input-paste.js";
import { isRecord, strArg } from "@/utils/index.js";

const TEST_PNG_PATH = join(dirname(fileURLToPath(import.meta.url)), "test.png");
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

describe("@file mention expansion", () => {
  it("inline a referenced file's contents", () => {
    const cwd = mkdtempSync(join(tmpdir(), "yukino-at-"));
    writeFileSync(join(cwd, "notes.md"), "hello from notes");

    const out = expandAtRefs("please read @notes.md and summarize", cwd);
    expect(out).toContain("please read @notes.md and summarize");
    expect(out).toContain('<file path="notes.md">');
    expect(out).toContain("hello from notes");
  });

  it("leaves non-file @tokens untouched", () => {
    const cwd = mkdtempSync(join(tmpdir(), "yukino-at-"));
    const text = "ping @alice about @nonexistent.txt";
    expect(expandAtRefs(text, cwd)).toBe(text);
  });

  it("returns the text unchanged when there are no @refs", () => {
    const cwd = mkdtempSync(join(tmpdir(), "yukino-at-"));
    expect(expandAtRefs("just a plain message", cwd)).toBe(
      "just a plain message",
    );
  });

  it("de-duplicates repeated references", () => {
    const cwd = mkdtempSync(join(tmpdir(), "yukino-at-"));
    writeFileSync(join(cwd, "a.txt"), "AAA");
    const out = expandAtRefs("@a.txt and again @a.txt", cwd);
    expect(out.match(/<file path="a.txt">/g)?.length).toBe(1);
  });
});

describe("@image mention expansion (expandAtRefsWithImages)", () => {
  it.each([
    "'@screen shot.png'",
    '"@screen shot.png"',
    '@"screen shot.png"',
    "@'screen shot.png'",
  ])(
    "restores an image placeholder through quoted mention %s to an image block",
    async (reference) => {
      const cwd = mkdtempSync(join(tmpdir(), "yukino-at-img-"));
      copyFileSync(TEST_PNG_PATH, join(cwd, "screen shot.png"));
      const collapsed = collapseImage(reference);
      expect(collapsed.text).toBe("[Image #1]");
      const out = await expandAtRefsWithImages(
        expandPastes(`See${collapsed.text}please`, collapsed.store),
        cwd,
      );
      if (typeof out === "string") {
        throw new Error(
          "expected image content blocks after placeholder expansion",
        );
      }
      expect(out.filter((block) => block.type === "image")).toHaveLength(1);
      expect(strArg(out[0], "text")).toContain('path="screen shot.png"');
    },
  );

  it("returns a plain string when no image is referenced", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "yukino-at-img-"));
    writeFileSync(join(cwd, "a.txt"), "AAA");
    const out = await expandAtRefsWithImages("read @a.txt", cwd);
    expect(typeof out).toBe("string");
    expect(out).toContain("AAA");
  });

  it("loads @image refs as inline image blocks with a placeholder appendix", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "yukino-at-img-"));
    copyFileSync(TEST_PNG_PATH, join(cwd, "shot.png"));
    writeFileSync(join(cwd, "notes.md"), "context");

    const out = await expandAtRefsWithImages(
      "see @shot.png and @notes.md",
      cwd,
    );
    if (typeof out === "string") {
      throw new Error("expected content blocks");
    }
    // Leading text block keeps the typed text, the placeholder, and the
    // inlined text file.
    expect(out[0].type).toBe("text");
    const text = strArg(out[0], "text");
    expect(text).toContain("see @shot.png and @notes.md");
    expect(text).toContain(
      '<image type="base64" media_type="image/jpeg" path="shot.png" />',
    );
    expect(text).toContain('<file path="notes.md">');
    const image = out.find((b) => b.type === "image");
    expect(image).toBeDefined();
    const source = image?.source;
    expect(isRecord(source) ? source.type : null).toBe("base64");
    expect(
      isRecord(source) &&
        typeof source.data === "string" &&
        source.data.length > 0,
    ).toBe(true);
  });
});

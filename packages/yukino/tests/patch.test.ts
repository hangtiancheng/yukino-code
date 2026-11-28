import { describe, expect, it } from "vitest";

import { parseFilePatches, patchPaths } from "@/tools/patch.js";

describe("unified diff file operations", () => {
  it("includes sources and destinations in permission checks", () => {
    const text = "--- a/old.txt\n+++ b/new.txt\n@@ -1 +1 @@\n-old\n+new\n";
    expect(parseFilePatches(text)[0]).toMatchObject({
      type: "update",
      path: "old.txt",
      movePath: "new.txt",
    });
    expect(patchPaths(text)).toEqual(["old.txt", "new.txt"]);
  });
  it("keeps absolute paths and recognizes additions and deletions", () => {
    expect(
      parseFilePatches(
        "--- /dev/null\n+++ /tmp/new.txt\n@@ -0,0 +1 @@\n+new\n",
      )[0],
    ).toMatchObject({ type: "add", path: "/tmp/new.txt" });
    expect(
      parseFilePatches(
        "--- a/old.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-old\n",
      )[0],
    ).toMatchObject({ type: "delete", path: "old.txt" });
  });
  it.each(["", "invalid", "@@ -1 +1 @@\n-a\n+b\n", "--- a/\n+++ b/\n"])(
    "rejects missing paths or changes: %s",
    (text) => {
      expect(() => parseFilePatches(text)).toThrow();
    },
  );
  it("rejects binary changes", () => {
    expect(() =>
      parseFilePatches("diff --git a/f b/f\nBinary files a/f and b/f differ\n"),
    ).toThrow();
  });
});

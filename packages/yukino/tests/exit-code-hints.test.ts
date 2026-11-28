import { expect, it } from "vitest";

import { extractBaseCmd } from "@/tools/exit-code-hints.js";

it.each([
  [String.raw`printf a\|b`, "printf"],
  [String.raw`echo foo\;bar`, "echo"],
  ['"/opt/My Tools/git" diff', "git"],
  ["false & echo ok", "echo"],
  ["PREFIX=value git diff | grep changed", "grep"],
  ["git diff # a comment with ; separators", "git"],
])("identifies the executable in %s", (command, expected) => {
  expect(extractBaseCmd(command)).toBe(expected);
});

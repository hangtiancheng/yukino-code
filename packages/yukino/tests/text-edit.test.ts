import { expect, it } from "vitest";

import { collapsePaste } from "@/ui/input-paste.js";
import { editText } from "@/ui/text-edit.js";

it("deletes a complete grapheme and joins adjacent lines at their boundary", () => {
  const emoji = "👩‍💻";
  const state = editText(
    { lines: [`a${emoji}`, "b"], cursorLine: 0, cursorCol: 1 + emoji.length },
    "backspace",
  );
  expect(state).toEqual({ lines: ["a", "b"], cursorLine: 0, cursorCol: 1 });
  expect(
    editText({ ...state, cursorLine: 1, cursorCol: 0 }, "backspace"),
  ).toEqual({ lines: ["ab"], cursorLine: 0, cursorCol: 1 });
  expect(
    editText({ lines: ["a", "b"], cursorLine: 0, cursorCol: 1 }, "delete"),
  ).toEqual({ lines: ["ab"], cursorLine: 0, cursorCol: 1 });
});

it("moves over and deletes collapsed paste markers as a single item", () => {
  const paste = collapsePaste("x".repeat(1100));
  const initial = { lines: [paste.text], cursorLine: 0, cursorCol: 0 };
  expect(editText(initial, "right", paste.store).cursorCol).toBe(
    paste.text.length,
  );
  expect(editText(initial, "delete", paste.store).lines).toEqual([""]);
});

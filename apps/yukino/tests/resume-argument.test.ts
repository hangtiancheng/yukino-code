import { describe, expect, it } from "vitest";

import { parseResumeArgument } from "@/ui/resume-argument.js";

describe("UI selection", () => {
  it("parses interactive and direct resume requests", () => {
    expect(parseResumeArgument([])).toBeUndefined();
    expect(parseResumeArgument(["--resume"])).toBe(true);
    expect(parseResumeArgument(["--resume", "session-123"])).toBe(
      "session-123",
    );
    expect(parseResumeArgument(["--resume=session-456"])).toBe("session-456");
  });
});

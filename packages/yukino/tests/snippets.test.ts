import { describe, expect, it } from "vitest";

import { MACOS_SNIPPET } from "@/tools/snippets.js";

describe("MACOS_SNIPPET", () => {
  it("emits a valid Swift backslash literal in the key map", () => {
    // The generated Swift source must contain "\\" (an escaped backslash) as
    // the dictionary key; a single backslash would escape the closing quote
    // and leave an unterminated string literal, so swiftc fails to compile
    // the helper and every macOS ComputerUse action breaks.
    expect(MACOS_SNIPPET).toContain('"\\\\": 42');
    expect(MACOS_SNIPPET).not.toContain('"\\": 42');
  });

  it("keeps single-backslash Swift string interpolation", () => {
    // MACOS_SNIPPET uses String.raw, so source backslashes pass through
    // verbatim and the interpolation lines must carry a single backslash
    // (Swift's "\(…)"). Doubling them would print literal "\(Int(...))"
    // text; dropping String.raw would silently eat the backslash and print
    // "(Int(...))". Both variants still compile, so only the assertions
    // below catch them.
    expect(MACOS_SNIPPET).toContain(
      'print("\\(Int(bounds.width)),\\(Int(bounds.height))")',
    );
    expect(MACOS_SNIPPET).toContain(
      'print("\\(Int(event.location.x)),\\(Int(event.location.y))")',
    );
  });
});

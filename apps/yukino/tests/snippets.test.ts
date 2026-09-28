/**
 * Copyright (c) 2026 hangtiancheng
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

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

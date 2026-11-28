import { describe, expect, it } from "vitest";

import {
  DEFAULT_FRAME_HEIGHT,
  DEFAULT_HOST_MAX_HEIGHT,
  HEIGHT_MESSAGE_SOURCE,
  readContentHeight,
  readHostMaxHeight,
  resolveFrameHeight,
  withHeightReporter,
} from "@/tools/create-app/frame-size.js";

describe("withHeightReporter", () => {
  it("inserts the reporter once, just after head", () => {
    const html =
      "<html><head><title>x</title></head><body><p>hi</p></body></html>";
    const once = withHeightReporter(html);
    const twice = withHeightReporter(once);
    expect(once).toContain(HEIGHT_MESSAGE_SOURCE);
    expect(once.indexOf(HEIGHT_MESSAGE_SOURCE)).toBeGreaterThan(
      once.indexOf("<head>"),
    );
    expect(once.indexOf(HEIGHT_MESSAGE_SOURCE)).toBeLessThan(
      once.indexOf("<title>"),
    );
    expect(twice).toBe(once);
    expect(once).toContain("body.offsetHeight");
    expect(once).not.toContain("doc.scrollHeight");
  });

  it("prepends the reporter when the document has no head", () => {
    const html = "<p>hi</p>";
    expect(withHeightReporter(html).endsWith(html)).toBe(true);
  });
});

describe("resolveFrameHeight", () => {
  it("uses a roomy default before the page reports its height", () => {
    expect(
      resolveFrameHeight({ navHeight: 32, maxHeight: DEFAULT_HOST_MAX_HEIGHT }),
    ).toBe(DEFAULT_FRAME_HEIGHT);
  });

  it("uses the page height when it fits under the host cap", () => {
    expect(
      resolveFrameHeight({
        contentHeight: 320.2,
        navHeight: 32,
        maxHeight: 800,
      }),
    ).toBe(321);
  });

  it("keeps the nav and the page inside the host max height", () => {
    expect(
      resolveFrameHeight({
        contentHeight: 2000,
        navHeight: 40,
        maxHeight: 800,
      }),
    ).toBe(760);
  });
});

describe("readContentHeight", () => {
  it("reads a height report from the sandboxed page", () => {
    expect(
      readContentHeight({ source: HEIGHT_MESSAGE_SOURCE, height: 360 }),
    ).toBe(360);
  });

  it("ignores unrelated messages", () => {
    expect(readContentHeight({ source: "other", height: 360 })).toBeUndefined();
    expect(
      readContentHeight({ source: HEIGHT_MESSAGE_SOURCE, height: 0 }),
    ).toBeUndefined();
  });
});

describe("readHostMaxHeight", () => {
  it("prefers a fixed host height, then maxHeight, then the default", () => {
    expect(readHostMaxHeight({ height: 600, maxHeight: 800 })).toBe(600);
    expect(readHostMaxHeight({ maxHeight: 800 })).toBe(800);
    expect(readHostMaxHeight(undefined)).toBe(DEFAULT_HOST_MAX_HEIGHT);
  });
});

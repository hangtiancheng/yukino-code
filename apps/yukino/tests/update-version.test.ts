import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  checkForUpdate,
  getLatestVersion,
  isNewerVersion,
} from "@/update/version-check.js";
import { version } from "@/version.js";

beforeEach(() => {
  vi.stubEnv("YUKINO_SKIP_VERSION_CHECK", "");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("update versions", () => {
  it.each([
    ["1.10.0", "1.9.0", true],
    ["1.0.0", "1.0.0", false],
    ["0.9.9", "1.0.0", false],
    ["0.0.13-dev", "0.0.12", true],
    ["0.0.13-canary", "0.0.12", true],
    ["0.0.14-canary", "0.0.13-dev", true],
    ["0.0.13-canary", "0.0.13-dev", false],
    ["1.0.0", "1.0.0-rc.2", true],
    ["1.0.0-rc.2", "1.0.0", false],
    ["1.0.0-beta.10", "1.0.0-beta.9", true],
    ["1.0.0-beta", "1.0.0-alpha", true],
    ["1.0.0-beta.1", "1.0.0-beta", true],
    ["1.0.0-1", "1.0.0-alpha", false],
    ["1.0.0+new", "1.0.0+old", false],
  ])("compares %s against %s", (candidate, current, newer) => {
    expect(isNewerVersion(candidate, current)).toBe(newer);
  });

  it.each(["latest", "01.2.3", "1.2.3-01", "1.2.3;echo injected"])(
    "rejects invalid registry versions: %s",
    async (invalid) => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(Response.json({ version: invalid })),
      );
      await expect(getLatestVersion()).rejects.toThrow(
        "Invalid package version",
      );
    },
  );

  it("requests npm's latest release with a cancellable versioned request", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(Response.json({ version: "999.0.0" }));
    vi.stubGlobal("fetch", fetch);
    const controller = new AbortController();
    await expect(checkForUpdate(controller.signal)).resolves.toBe("999.0.0");
    const options = fetch.mock.calls[0][1];
    expect(options).toMatchObject({
      headers: {
        accept: "application/json",
        "User-Agent": `yukino/${version} (${process.platform}; ${process.arch})`,
      },
    });
    expect(options?.signal).toBeInstanceOf(AbortSignal);
    expect(fetch.mock.calls[0][0]).toBe(
      "https://registry.npmjs.org/@yukino.js%2Fyukino/latest",
    );
    controller.abort();
    expect(options?.signal?.aborted).toBe(true);
  });

  it.each([version, "0.0.0"])("does not announce %s", async (latest) => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(Response.json({ version: latest })),
    );
    await expect(checkForUpdate()).resolves.toBeUndefined();
  });

  it.each([
    ["canary", "0.0.14-canary"],
    ["next", "0.0.14-dev"],
    ["preview-branch.1", "0.0.14"],
    ["latest", "0.0.14-dev"],
  ])("resolves npm dist-tag %s to %s", async (tag, expected) => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(Response.json({ version: expected }));
    vi.stubGlobal("fetch", fetch);
    const controller = new AbortController();
    await expect(
      getLatestVersion({ tag, signal: controller.signal }),
    ).resolves.toBe(expected);
    expect(fetch.mock.calls[0][0]).toBe(
      `https://registry.npmjs.org/@yukino.js%2Fyukino/${tag}`,
    );
    controller.abort();
    expect(fetch.mock.calls[0][1]?.signal?.aborted).toBe(true);
  });

  it.each([
    "",
    " ",
    "bad tag",
    "../latest",
    "canary?x=1",
    "canary#latest",
    ".",
    "..",
  ])("rejects invalid npm dist-tag %j before fetching", async (tag) => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(getLatestVersion({ tag })).rejects.toThrow(
      "Invalid npm dist-tag",
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reports a missing dist-tag without falling back to latest", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 404 }));
    vi.stubGlobal("fetch", fetch);
    await expect(getLatestVersion({ tag: "canary" })).rejects.toThrow(
      'No Yukino release found for npm dist-tag "canary".',
    );
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("disables only automatic checks", async () => {
    vi.stubEnv("YUKINO_SKIP_VERSION_CHECK", "1");
    const fetch = vi
      .fn()
      .mockResolvedValue(Response.json({ version: "999.0.0" }));
    vi.stubGlobal("fetch", fetch);
    await expect(checkForUpdate()).resolves.toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
    await expect(getLatestVersion()).resolves.toBe("999.0.0");
  });

  it("suppresses background failures but reports explicit check failures", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("network unavailable")),
    );
    await expect(checkForUpdate()).resolves.toBeUndefined();
    await expect(getLatestVersion()).rejects.toThrow("network unavailable");
  });

  it("rejects HTTP errors and malformed metadata", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(Response.json({ version: 12 }));
    vi.stubGlobal("fetch", fetch);
    await expect(getLatestVersion()).rejects.toThrow("HTTP 503");
    await expect(getLatestVersion()).rejects.toThrow();
  });
});

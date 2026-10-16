import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runUpdate } from "@/update/index.js";
import { version } from "@/version.js";

const install = vi.hoisted(() => ({
  getSelfUpdateCommand: vi.fn(),
  runSelfUpdate: vi.fn(),
}));
vi.mock("@/update/install.js", () => install);
vi.mock("@/version.js", () => ({ version: "0.0.13-dev" }));

const initialExitCode = process.exitCode;
beforeEach(() => {
  process.exitCode = undefined;
  install.getSelfUpdateCommand
    .mockReset()
    .mockResolvedValue({ command: "npm", args: [] });
  install.runSelfUpdate.mockReset().mockResolvedValue(undefined);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  process.exitCode = initialExitCode;
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("yukino update", () => {
  it("installs the checked version without provider configuration", async () => {
    vi.stubEnv("YUKINO_SKIP_VERSION_CHECK", "1");
    const fetch = vi
      .fn()
      .mockResolvedValue(Response.json({ version: "999.0.0" }));
    vi.stubGlobal("fetch", fetch);
    await runUpdate();
    expect(fetch).toHaveBeenCalledWith(
      "https://registry.npmjs.org/@yukino.js%2Fyukino/latest",
      expect.any(Object),
    );
    expect(install.getSelfUpdateCommand).toHaveBeenCalledWith("999.0.0");
    expect(install.runSelfUpdate).toHaveBeenCalledOnce();
    expect(console.log).toHaveBeenLastCalledWith(
      `Updated Yukino from v${version} to v999.0.0.`,
    );
    expect(process.exitCode).toBeUndefined();
  });

  it.each([
    ["latest", "0.0.14"],
    ["canary", "0.0.14-canary"],
    ["dev", "0.0.14-dev"],
  ])("updates with %s from the selected dist-tag", async (tag, latest) => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ version: latest }));
    vi.stubGlobal("fetch", fetch);
    await runUpdate(tag);
    expect(fetch).toHaveBeenCalledWith(
      `https://registry.npmjs.org/@yukino.js%2Fyukino/${tag}`,
      expect.any(Object),
    );
    expect(install.getSelfUpdateCommand).toHaveBeenCalledWith(latest);
    expect(install.runSelfUpdate).toHaveBeenCalledOnce();
    expect(console.log).toHaveBeenLastCalledWith(
      `Updated Yukino from v${version} to v${latest}.`,
    );
    expect(process.exitCode).toBeUndefined();
  });

  it.each(["0.0.13-dev", "0.0.12", "0.0.13-canary"])(
    "does not reinstall or downgrade to canary's %s",
    async (latest) => {
      const fetch = vi
        .fn()
        .mockResolvedValue(Response.json({ version: latest }));
      vi.stubGlobal("fetch", fetch);
      await runUpdate("canary");
      expect(fetch).toHaveBeenCalledWith(
        "https://registry.npmjs.org/@yukino.js%2Fyukino/canary",
        expect.any(Object),
      );
      expect(install.getSelfUpdateCommand).not.toHaveBeenCalled();
      expect(install.runSelfUpdate).not.toHaveBeenCalled();
      expect(process.exitCode).toBeUndefined();
    },
  );

  it("reports a missing canary tag without attempting an install", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 404 }));
    vi.stubGlobal("fetch", fetch);
    await runUpdate("canary");
    expect(process.exitCode).toBe(1);
    expect(console.error).toHaveBeenCalledWith(
      'Update failed: No Yukino release found for npm dist-tag "canary".',
    );
    expect(fetch).toHaveBeenCalledOnce();
    expect(install.getSelfUpdateCommand).not.toHaveBeenCalled();
    expect(install.runSelfUpdate).not.toHaveBeenCalled();
  });

  it.each([version, "0.0.0"])(
    "does not reinstall or downgrade to %s",
    async (latest) => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(Response.json({ version: latest })),
      );
      await runUpdate();
      expect(install.runSelfUpdate).not.toHaveBeenCalled();
      expect(console.log).toHaveBeenCalledWith(
        `Yukino is already up to date (v${version}).`,
      );
    },
  );

  it.each(["check", "install"])(
    "returns a failing exit code on %s failure",
    async (failure) => {
      vi.stubGlobal(
        "fetch",
        failure === "check"
          ? vi.fn().mockRejectedValue(new Error("network unavailable"))
          : vi.fn().mockResolvedValue(Response.json({ version: "999.0.0" })),
      );
      install.runSelfUpdate.mockRejectedValue(new Error("install failed"));
      await runUpdate();
      expect(process.exitCode).toBe(1);
      expect(console.error).toHaveBeenCalledWith(
        expect.stringMatching(/^Update failed:/u),
      );
      expect(console.log).not.toHaveBeenCalledWith(
        expect.stringMatching(/^Updated Yukino/u),
      );
    },
  );

  it.each(["", "../latest"])(
    "rejects the invalid dist-tag %j before making network requests",
    async (tag) => {
      const fetch = vi.fn();
      vi.stubGlobal("fetch", fetch);
      await runUpdate(tag);
      expect(process.exitCode).toBe(1);
      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining("Invalid npm dist-tag"),
      );
      expect(fetch).not.toHaveBeenCalled();
      expect(install.runSelfUpdate).not.toHaveBeenCalled();
    },
  );
});

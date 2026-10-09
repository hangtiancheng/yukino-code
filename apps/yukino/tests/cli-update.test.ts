import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { version } from "@/version.js";

let directory = "";
beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), "yukino-cli-update-"));
  writeFileSync(
    join(directory, "package.json"),
    JSON.stringify({ type: "module" }),
  );
  const dist = join(import.meta.dirname, "..", "dist");
  for (const entry of readdirSync(dist, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".js")) {
      cpSync(join(dist, entry.name), join(directory, entry.name));
    }
  }
});
afterAll(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe("standalone maintenance entry", () => {
  it.each([
    [["--version"], version],
    [["update", "--help"], "Usage: yukino update"],
    [["update", "-h"], "--tag <tag>"],
    [["update", "--tag=canary", "--help"], "default: latest"],
  ])(
    "runs %j without loading native dependencies or configuration",
    (args, output) => {
      const result = spawnSync(
        process.execPath,
        [join(directory, "main.js"), ...args],
        {
          cwd: directory,
          encoding: "utf8",
          timeout: 10_000,
        },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain(output);
      expect(result.stderr).toBe("");
    },
  );

  it.each([
    [["update"], "latest"],
    [["update", "--tag=canary"], "canary"],
    [["update", "--tag", "canary"], "canary"],
  ])("checks %j without starting the runtime", (args, tag) => {
    const url = `https://registry.npmjs.org/@yukino.js%2Fyukino/${tag}`;
    const preload = `data:text/javascript,${encodeURIComponent(
      `globalThis.fetch = async (url) => {
        if (url !== ${JSON.stringify(url)}) throw new Error("Unexpected registry URL: " + url);
        return Response.json({ version: ${JSON.stringify(version)} });
      };`,
    )}`;
    const result = spawnSync(
      process.execPath,
      ["--import", preload, join(directory, "main.js"), ...args],
      {
        cwd: directory,
        encoding: "utf8",
        timeout: 10_000,
      },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(
      `Yukino is already up to date (v${version}).`,
    );
    expect(result.stderr).toBe("");
  });

  it("rejects invalid update arguments before starting the runtime", () => {
    const result = spawnSync(
      process.execPath,
      [join(directory, "main.js"), "update", "unexpected"],
      {
        cwd: directory,
        encoding: "utf8",
        timeout: 10_000,
      },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Usage: yukino update");
    expect(result.stderr).not.toContain("sharp");
  });
});

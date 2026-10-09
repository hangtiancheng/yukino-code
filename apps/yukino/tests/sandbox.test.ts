import { describe, expect, it } from "vitest";

import { BwrapSandbox } from "@/sandbox/bwrap.js";
import { SeatbeltSandbox } from "@/sandbox/seatbelt.js";

const config = {
  allowWrite: ["."],
  denyWrite: ["private"],
  networkEnabled: false,
};

describe("native sandboxes", () => {
  it("prepares bwrap argv without passing the command through an outer shell", () => {
    const prepared = new BwrapSandbox().prepare(
      "true; echo still-contained",
      config,
      { cwd: "/workspace" },
    );

    expect(prepared.executable).toBe("bwrap");
    expect(prepared.args.slice(-4)).toEqual([
      "--",
      "bash",
      "-c",
      "true; echo still-contained",
    ]);
  });

  it("prepares seatbelt as an executable and argument vector", () => {
    const prepared = new SeatbeltSandbox().prepare("printf ok", config, {
      cwd: "/workspace",
    });

    expect(prepared.executable).toBe("/usr/bin/sandbox-exec");
    expect(prepared.args.slice(-3)).toEqual(["bash", "-c", "printf ok"]);
    expect(prepared.args[1]).toContain(
      '(deny file-write* (literal "/workspace/private"))',
    );
    expect(prepared.args[1]).toContain(
      '(deny file-write* (subpath "/workspace/private"))',
    );
  });

  it("escapes configured paths inside the seatbelt profile", () => {
    const injected = '/tmp/a"\\) (allow file-write* (subpath "/"))';
    const prepared = new SeatbeltSandbox().prepare(
      "printf ok",
      {
        allowWrite: [injected],
        denyWrite: [],
        networkEnabled: false,
      },
      { cwd: "/workspace" },
    );

    expect(prepared.args[1]).toContain(
      '(allow file-write* (subpath "/tmp/a\\"\\\\) (allow file-write* (subpath \\"/\\"))"))',
    );
    expect(prepared.args[1]).not.toContain(
      '(subpath "/tmp/a"\\) (allow file-write* (subpath "/"))")',
    );
  });

  it("rejects paths that could inject additional profile lines", () => {
    expect(() =>
      new SeatbeltSandbox().prepare(
        "printf ok",
        {
          allowWrite: ["/tmp/safe\n(allow network*)"],
          denyWrite: [],
          networkEnabled: false,
        },
        { cwd: "/workspace" },
      ),
    ).toThrow("cannot contain NUL or newline");
  });
});

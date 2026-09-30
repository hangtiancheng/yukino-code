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
    const prepared = new SeatbeltSandbox().prepare("printf ok", config);

    expect(prepared.executable).toBe("/usr/bin/sandbox-exec");
    expect(prepared.args.slice(-3)).toEqual(["bash", "-c", "printf ok"]);
    expect(prepared.args[1]).toContain(
      '(deny file-write* (literal "private"))',
    );
    expect(prepared.args[1]).toContain(
      '(deny file-write* (subpath "private"))',
    );
  });
});

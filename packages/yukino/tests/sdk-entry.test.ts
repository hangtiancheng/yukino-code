import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, expectTypeOf, it } from "vitest";

import type {
  AgentSession,
  CostEntry,
  CostSummary,
  RunRelation,
  RuntimeStatus,
} from "@/sdk/index.js";
import { getYukinoDir } from "@/storage/index.js";

function runExample(
  home: string,
): Promise<{ code: number | null; output: string; error: string }> {
  const example = fileURLToPath(
    new URL("../examples/sdk.mjs", import.meta.url),
  );
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [example], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, HOME: home, USERPROFILE: home },
    });
    let output = "";
    let error = "";
    const deadline = setTimeout(() => {
      child.kill();
      reject(new Error("SDK example timed out"));
    }, 20_000);
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      error += chunk.toString();
    });
    child.on("error", (failure) => {
      clearTimeout(deadline);
      reject(failure);
    });
    child.on("close", (code) => {
      clearTimeout(deadline);
      resolve({ code, output, error });
    });
  });
}

describe("published SDK entry without a TTY", () => {
  it("exports safe status and ledger history types", () => {
    expectTypeOf<
      AgentSession["getStatus"]
    >().returns.toEqualTypeOf<RuntimeStatus>();
    expectTypeOf<
      AgentSession["getStats"]
    >().returns.toEqualTypeOf<CostSummary>();
    expectTypeOf<AgentSession["getCostEntries"]>().returns.toEqualTypeOf<
      CostEntry[]
    >();
    expectTypeOf<RunRelation>().toExtend<{
      sessionId: string;
      runId: string;
      parentRunId?: string;
    }>();
  });

  it("runs the formal-package mock example in a clean HOME and exits naturally", async () => {
    const home = join(dirname(getYukinoDir()), "sdk-child-home");
    mkdirSync(home);
    const result = await runExample(home);
    expect(result.error).toBe("");
    expect(result.code).toBe(0);
    expect(result.output).toContain('"status":"ok"');
  });
});

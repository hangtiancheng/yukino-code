import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import { afterEach, describe, expect, it } from "vitest";

import { INVOCATION_MAX_TEXT_BYTES } from "@/bootstrap/constants.js";
import { prepareInvocationSession } from "@/bootstrap/headless.js";
import {
  loadInvocationInput,
  readInvocationText,
  readStdinPrompt,
  resolveInvocationProvider,
} from "@/bootstrap/invocation.js";
import { persistPreferences } from "@/config/preferences.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function directory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "yukino-invocation-"));
  directories.push(path);
  return path;
}

describe("invocation boundaries", () => {
  it("reads bounded prompt files as data without executing them", async () => {
    const cwd = await directory();
    await writeFile(
      join(cwd, "prompt.js"),
      'process.exit(42); require("node:fs").writeFileSync("secret", "x");',
    );
    expect(await readInvocationText("prompt.js", cwd)).toContain(
      "process.exit(42)",
    );
    await expect(readFile(join(cwd, "secret"))).rejects.toThrow();
  });

  it("rejects binary, invalid UTF-8 and oversized prompt input", async () => {
    const cwd = await directory();
    await writeFile(join(cwd, "binary"), Buffer.from([0, 1, 2]));
    await writeFile(join(cwd, "invalid"), Buffer.from([0xff]));
    await writeFile(
      join(cwd, "large"),
      "x".repeat(INVOCATION_MAX_TEXT_BYTES + 1),
    );
    await expect(readInvocationText("binary", cwd)).rejects.toThrow();
    await expect(readInvocationText("invalid", cwd)).rejects.toThrow();
    await expect(readInvocationText("large", cwd)).rejects.toThrow();
    await expect(
      readStdinPrompt(
        Readable.from([Buffer.alloc(INVOCATION_MAX_TEXT_BYTES + 1)]),
      ),
    ).rejects.toThrow("limit");
  });

  it("handles split Unicode stdin and explicit text attachments", async () => {
    const bytes = Buffer.from("雪のコード");
    expect(
      await readStdinPrompt(
        Readable.from([bytes.subarray(0, 2), bytes.subarray(2)]),
      ),
    ).toBe("雪のコード");
    const cwd = await directory();
    await writeFile(join(cwd, "code.txt"), "const result = 1;");
    const content = await loadInvocationInput(
      "review",
      { attachments: ["code.txt"] },
      cwd,
    );
    expect(content).toEqual([
      { type: "text", text: "review" },
      {
        type: "text",
        text: '<attachment path="code.txt">\nconst result = 1;\n</attachment>',
      },
    ]);
  });

  it("retains the project-relative config path for later settings writes", async () => {
    const cwd = await directory();
    const path = join(cwd, "custom.yaml");
    await writeFile(
      path,
      "providers:\n  - name: local\n    protocol: openai\n    model: fixture\n    base_url: https://fixture.invalid\n",
      { mode: 0o600 },
    );
    const invocation = await prepareInvocationSession({
      cwd,
      config: "custom.yaml",
      persist: false,
    });
    expect(invocation.configPath).toBe(await realpath(path));
    expect(invocation.config.providers[0]?.name).toBe("local");
    persistPreferences({ auto_retry: false }, invocation.configPath);
    expect(await readFile(path, "utf8")).toContain("auto_retry: false");
  });

  it("does not borrow another configured credential or old model metadata", () => {
    const selected = {
      name: "selected",
      protocol: "openai" as const,
      base_url: "https://local.invalid/v1",
      api_key: "selected-key",
      model: "old",
      context_window: 500,
      reasoning: false,
      price: {
        input: 2,
        currency: "USD",
        source: "test",
        effective_at: "2026-01-01T00:00:00.000Z",
      },
    };
    const other = {
      ...selected,
      name: "other",
      api_key: "other-key",
      model: "new",
    };
    const result = resolveInvocationProvider([selected, other], 0, {
      provider: "selected",
      model: "new",
    });
    expect(result).toMatchObject({
      name: "selected",
      api_key: "selected-key",
      model: "new",
    });
    expect(result.context_window).not.toBe(500);
    expect(result.price).toBeUndefined();
    expect(result.reasoning).toBeUndefined();
  });
});

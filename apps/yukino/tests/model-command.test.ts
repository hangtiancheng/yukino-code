import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import type * as nodeOs from "node:os";
import { join } from "node:path";

import yaml from "js-yaml";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { createDefaultRegistry, parse } from "@/commands/commands.js";
import { loadConfig } from "@/config/index.js";
import { globalConfigPath } from "@/config/provider-config.js";
import { persistModel, saveProvider } from "@/config/provider-login.js";

// Point os.homedir() at a temp dir so persistModel writes to an isolated
// global config instead of the real ~/.yukino/config.yaml.
const homeRef = vi.hoisted(() => ({ current: "" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof nodeOs>();
  return { ...actual, homedir: () => homeRef.current };
});

const input = {
  name: "custom",
  protocol: "anthropic",
  base_url: "https://example.com",
  api_key: "test-key",
  model: "test-model",
};

beforeEach(() => {
  homeRef.current = mkdtempSync(join(tmpdir(), "yukino-home-"));
});

afterEach(() => {
  rmSync(homeRef.current, { recursive: true, force: true });
});

describe("/model command", () => {
  it("is registered as a local UI command", () => {
    const command = createDefaultRegistry().find("model");
    expect(command?.type).toBe("local_ui");
    expect(command?.handler({ workDir: "/tmp", args: "" })).toBe("model");
  });

  it("parses a bare command and one carrying a model id", () => {
    expect(parse("/model")).toEqual({ name: "model", args: "" });
    expect(parse("/model  claude-opus-4-5 ")).toEqual({
      name: "model",
      args: "claude-opus-4-5",
    });
  });
});

describe("persistModel", () => {
  it("updates only the model of the matching endpoint", () => {
    saveProvider(input, []);
    const path = globalConfigPath();
    persistModel(input.base_url, "other-model");
    expect(loadConfig(path).providers[0]).toMatchObject({
      name: "custom",
      base_url: input.base_url,
      model: "other-model",
      thinking: "high",
    });
  });

  it("leaves other endpoints untouched", () => {
    const first = saveProvider(input, []);
    const second = saveProvider(
      {
        ...input,
        base_url: "https://staging.example.com",
        model: "staging-model",
      },
      first.providers,
    );
    persistModel(input.base_url, "new-model");
    expect(
      loadConfig(second.path).providers.map((p) => [p.base_url, p.model]),
    ).toEqual([
      [input.base_url, "new-model"],
      ["https://staging.example.com", "staging-model"],
    ]);
  });

  it("updates every entry sharing the endpoint", () => {
    mkdirSync(join(homeRef.current, ".yukino"));
    const path = globalConfigPath();
    writeFileSync(
      path,
      [
        "providers:",
        "  - name: first",
        "    protocol: anthropic",
        `    base_url: ${input.base_url}`,
        "    model: old-model",
        "  - name: second",
        "    protocol: anthropic",
        `    base_url: ${input.base_url}`,
        "    model: old-model",
        "",
      ].join("\n"),
    );
    persistModel(input.base_url, "shared-model");
    const raw = z
      .object({ providers: z.array(z.object({ model: z.string() })) })
      .parse(yaml.load(readFileSync(path, "utf-8")));
    expect(raw.providers.map((p) => p.model)).toEqual([
      "shared-model",
      "shared-model",
    ]);
  });

  it("does not rewrite the file when the model is unchanged", () => {
    saveProvider(input, []);
    const path = globalConfigPath();
    const before = readFileSync(path, "utf-8");
    const { mtimeMs } = statSync(path);
    persistModel(input.base_url, input.model);
    expect(readFileSync(path, "utf-8")).toBe(before);
    expect(statSync(path).mtimeMs).toBe(mtimeMs);
  });

  it("throws for an unknown endpoint", () => {
    saveProvider(input, []);
    expect(() => {
      persistModel("https://unknown.example.com", "some-model");
    }).toThrow(/base URL/);
  });
});

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

import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import type * as os from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PermissionChecker } from "@/permissions/index.js";
import {
  buildSkillSection,
  parseSkillFile,
  SkillCatalog,
} from "@/skills/catalog.js";
import { runFork, runInline } from "@/skills/executor.js";
import type { Skill, SkillForkHost } from "@/skills/index.js";
import { InstallSkillTool } from "@/skills/install-tool.js";

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof os>();
  return { ...actual, homedir: vi.fn(actual.homedir) };
});

let root: string;
let workDir: string;
let userDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "yukino-skills2-"));
  workDir = join(root, "project");
  userDir = join(root, "home");
  mkdirSync(workDir);
  mkdirSync(userDir);
  vi.mocked(homedir).mockReturnValue(userDir);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

function document(name = "demo", body = "Original instructions"): string {
  return `---\nname: ${JSON.stringify(name)}\ndescription: Demo skill\n---\n${body}`;
}

// Ecosystem only supports `.agents` currently
function writeSkill(
  base: string,
  ecosystem: string,
  name = "demo",
  body?: string,
): string {
  const file = join(base, ecosystem, "skills", name, "SKILL.md");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, document(name, body));
  return file;
}

function localInstaller(content = document()) {
  const source = join(workDir, "source.md");
  writeFileSync(source, content);
  const catalog = new SkillCatalog();
  const onInstalled = vi.fn();
  const tool = new InstallSkillTool(workDir, catalog, onInstalled);
  return { source, catalog, onInstalled, tool };
}

describe("skill installation boundaries", () => {
  it("uses write-tool approval in default and plan modes", () => {
    const { tool, source } = localInstaller();
    expect(tool.category).toBe("write");
    expect(
      new PermissionChecker(workDir).check(tool.name, tool.category, { source })
        .effect,
    ).toBe("ask");
    expect(
      new PermissionChecker(workDir, "plan").check(tool.name, tool.category, {
        source,
      }).effect,
    ).toBe("ask");
  });

  it.each([
    "..",
    ".",
    "../outside",
    "a/../../outside",
    "a/b",
    "a\\b",
    "C:\\outside",
    "/outside",
    "bad\0name",
    ".. ",
  ])(
    "rejects an unsafe name from either YAML or an override: %j",
    async (name) => {
      const { source, tool, catalog, onInstalled } = localInstaller();
      const overridden = await tool.execute({ workDir }, { source, name });
      writeFileSync(source, document(name));
      const fromYaml = await tool.execute({ workDir }, { source });
      expect(overridden.isError).toBe(true);
      expect(fromYaml.isError).toBe(true);
      expect(existsSync(join(workDir, ".agents"))).toBe(false);
      expect(catalog.list()).toEqual([]);
      expect(onInstalled).not.toHaveBeenCalled();
    },
  );

  it.each([
    ".agents",
    ".agents/skills",
    ".agents/skills/demo",
    ".agents/skills/demo/SKILL.md",
  ])("does not follow an installation symlink at %s", async (component) => {
    const { source, tool, onInstalled } = localInstaller();
    const outside = join(root, "outside");
    mkdirSync(outside);
    const protectedFile = join(outside, "SKILL.md");
    writeFileSync(protectedFile, "untouched");
    const link = join(workDir, component);
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(component.endsWith("SKILL.md") ? protectedFile : outside, link);
    const result = await tool.execute({ workDir }, { source });
    expect(result.isError).toBe(true);
    expect(readFileSync(protectedFile, "utf-8")).toBe("untouched");
    expect(readdirSync(outside)).toEqual(["SKILL.md"]);
    expect(onInstalled).not.toHaveBeenCalled();
  });

  it.each([".agents", ".agents/skills/demo/SKILL.md"])(
    "rejects a dangling symlink at %s",
    async (component) => {
      const { source, tool } = localInstaller();
      const link = join(workDir, component);
      mkdirSync(dirname(link), { recursive: true });
      const missing = join(root, "missing");
      symlinkSync(missing, link);
      expect((await tool.execute({ workDir }, { source })).isError).toBe(true);
      expect(existsSync(missing)).toBe(false);
    },
  );

  it("can install through a workspace alias without following child symlinks", async () => {
    const { source, catalog } = localInstaller();
    const alias = join(root, "project-alias");
    symlinkSync(workDir, alias);
    const result = await new InstallSkillTool(alias, catalog).execute(
      { workDir: alias },
      { source },
    );
    expect(result.isError).toBe(false);
    expect(catalog.has("demo")).toBe(true);
  });

  it("replaces a hard-linked destination without changing the other link", async () => {
    const { source, tool } = localInstaller();
    const file = writeSkill(workDir, ".agents", "demo", "old");
    const outside = join(root, "outside.md");
    linkSync(file, outside);
    const old = readFileSync(outside, "utf-8");
    expect((await tool.execute({ workDir }, { source })).isError).toBe(false);
    expect(readFileSync(outside, "utf-8")).toBe(old);
    expect(readFileSync(file, "utf-8")).toBe(document());
    expect(readdirSync(dirname(file))).toEqual(["SKILL.md"]);
  });

  it("updates the catalog name and preserves unknown YAML metadata on override", async () => {
    const original = document("demo").replace(
      "description:",
      "allowed_tools: [ReadFile]\ncustom: {enabled: true}\ndescription:",
    );
    const { source, tool, catalog, onInstalled } = localInstaller(original);
    const result = await tool.execute({ workDir }, { source, name: "renamed" });
    expect(result.isError).toBe(false);
    expect(catalog.has("renamed")).toBe(true);
    expect(catalog.has("demo")).toBe(false);
    const installed = readFileSync(
      join(workDir, ".agents/skills/renamed/SKILL.md"),
      "utf-8",
    );
    expect(parseSkillFile(installed)?.frontmatter).toMatchObject({
      name: "renamed",
      allowed_tools: ["ReadFile"],
      custom: { enabled: true },
    });
    expect(onInstalled).toHaveBeenCalledOnce();
  });

  it.each([
    "<html>GitHub tree page</html>",
    "plain markdown",
    "---\nname: [bad]\n---\nbody",
    "---\nname: ''\n---\nbody",
  ])(
    "rejects invalid content without replacing an existing skill: %j",
    async (content) => {
      const file = writeSkill(workDir, ".agents");
      const { tool, source, onInstalled } = localInstaller(content);
      const result = await tool.execute({ workDir }, { source, name: "demo" });
      expect(result.isError).toBe(true);
      expect(readFileSync(file, "utf-8")).toBe(document());
      expect(onInstalled).not.toHaveBeenCalled();
    },
  );

  it("returns tool errors for unreadable sources and invalid destination directories", async () => {
    const { source, tool } = localInstaller();
    expect((await tool.execute({ workDir }, { source: workDir })).isError).toBe(
      true,
    );
    writeFileSync(join(workDir, ".agents"), "keep me");
    expect((await tool.execute({ workDir }, { source })).isError).toBe(true);
    expect(readFileSync(join(workDir, ".agents"), "utf-8")).toBe("keep me");
  });
});

describe("skill download cancellation", () => {
  it.each(["source.md", "https://example.test/SKILL.md"])(
    "skips all work when already aborted: %s",
    async (source) => {
      const { tool, onInstalled } = localInstaller();
      const fetcher = vi.fn<typeof fetch>();
      vi.stubGlobal("fetch", fetcher);
      const result = await tool.execute(
        { workDir, abortSignal: AbortSignal.abort() },
        { source },
      );
      expect(result.isError).toBe(true);
      expect(fetcher).not.toHaveBeenCalled();
      expect(onInstalled).not.toHaveBeenCalled();
      expect(existsSync(join(workDir, ".agents"))).toBe(false);
    },
  );

  it("aborts an in-flight fetch when its caller cancels", async () => {
    const { tool, onInstalled } = localInstaller();
    let receivedSignal: AbortSignal | null | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>((_input, init) => {
        receivedSignal = init?.signal;
        return new Promise((_resolve, reject) => {
          receivedSignal?.addEventListener(
            "abort",
            () => {
              reject(new Error("request aborted"));
            },
            {
              once: true,
            },
          );
        });
      }),
    );
    const controller = new AbortController();
    const result = tool.execute(
      { workDir, abortSignal: controller.signal },
      { source: "https://example.test/SKILL.md" },
    );
    controller.abort();
    expect((await result).isError).toBe(true);
    expect(receivedSignal?.aborted).toBe(true);
    expect(onInstalled).not.toHaveBeenCalled();
    expect(existsSync(join(workDir, ".agents"))).toBe(false);
  });

  it.each(["headers", "body"])(
    "times out while waiting for response %s",
    async (phase) => {
      vi.useFakeTimers();
      const { tool, onInstalled } = localInstaller();
      let receivedSignal: AbortSignal | null | undefined;
      vi.stubGlobal(
        "fetch",
        vi.fn<typeof fetch>((_input, init) => {
          receivedSignal = init?.signal;
          if (phase === "headers") {
            return new Promise((_resolve, reject) => {
              receivedSignal?.addEventListener(
                "abort",
                () => {
                  reject(new Error("timed out"));
                },
                {
                  once: true,
                },
              );
            });
          }
          return Promise.resolve(
            new Response(
              new ReadableStream({
                start(controller) {
                  receivedSignal?.addEventListener(
                    "abort",
                    () => {
                      controller.error(new Error("timed out"));
                    },
                    { once: true },
                  );
                },
              }),
            ),
          );
        }),
      );
      const result = tool.execute(
        { workDir },
        { source: "https://example.test/SKILL.md" },
      );
      await vi.advanceTimersByTimeAsync(30_000);
      expect((await result).isError).toBe(true);
      expect(receivedSignal?.aborted).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
      expect(onInstalled).not.toHaveBeenCalled();
      expect(existsSync(join(workDir, ".agents"))).toBe(false);
    },
  );

  it("checks cancellation after consuming the response body", async () => {
    const { tool } = localInstaller();
    const controller = new AbortController();
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(() => {
        controller.abort();
        return Promise.resolve(new Response(document()));
      }),
    );
    expect(
      (
        await tool.execute(
          { workDir, abortSignal: controller.signal },
          { source: "https://example.test/SKILL.md" },
        )
      ).isError,
    ).toBe(true);
    expect(existsSync(join(workDir, ".agents"))).toBe(false);
  });

  it("installs raw URLs and releases the deadline after success or HTTP failure", async () => {
    vi.useFakeTimers();
    const { tool, catalog, onInstalled } = localInstaller();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(document()))
      .mockResolvedValueOnce(new Response("Not found", { status: 404 }));
    vi.stubGlobal("fetch", fetcher);
    const source = "https://example.test/SKILL.md";
    expect((await tool.execute({ workDir }, { source })).isError).toBe(false);
    expect(catalog.has("demo")).toBe(true);
    expect((await tool.execute({ workDir }, { source })).output).toContain(
      "404",
    );
    expect(onInstalled).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("skill catalog reload", () => {
  it.each([".agents"])(
    "watches project and user additions/removals in %s",
    (ecosystem) => {
      for (const base of [workDir, userDir]) {
        const catalog = new SkillCatalog();
        catalog.load(workDir);
        expect(catalog.needsReload()).toBe(false);
        const file = writeSkill(base, ecosystem);
        expect(catalog.needsReload()).toBe(true);
        catalog.reload();
        expect(catalog.has("demo")).toBe(true);
        expect(catalog.needsReload()).toBe(false);
        rmSync(join(base, ecosystem, "skills"), { recursive: true });
        expect(catalog.needsReload()).toBe(true);
        catalog.reload();
        expect(catalog.has("demo")).toBe(false);
        expect(existsSync(file)).toBe(false);
      }
    },
  );

  it("detects adding and deleting SKILL.md in an existing child directory", () => {
    const dir = join(workDir, ".agents/skills/demo");
    mkdirSync(dir, { recursive: true });
    const catalog = new SkillCatalog();
    catalog.load(workDir);
    const parentTime = statSync(dirname(dir)).mtimeMs;
    writeFileSync(join(dir, "SKILL.md"), document());
    utimesSync(dir, new Date(10_000), new Date(10_000));
    expect(statSync(dirname(dir)).mtimeMs).toBe(parentTime);
    expect(catalog.needsReload()).toBe(true);
    catalog.reload();
    expect(catalog.has("demo")).toBe(true);
    rmSync(join(dir, "SKILL.md"));
    expect(catalog.needsReload()).toBe(true);
    catalog.reload();
    expect(catalog.has("demo")).toBe(false);
  });

  it("clears stale entries on repeated loads and retains source precedence", () => {
    writeSkill(userDir, ".agents", "demo", "global");
    const preferred = writeSkill(workDir, ".agents", "demo", "project");
    const catalog = new SkillCatalog();
    catalog.load(workDir);
    expect(catalog.get("demo")?.body).toBe("project");
    rmSync(preferred);
    catalog.load(workDir);
    expect(catalog.get("demo")?.body).toBe("global");
    const elsewhere = join(root, "other-project");
    mkdirSync(elsewhere);
    catalog.load(elsewhere);
    expect(catalog.get("demo")?.body).toBe("global");
    rmSync(join(userDir, ".agents"), { recursive: true });
    catalog.load(elsewhere);
    expect(catalog.has("demo")).toBe(false);
  });

  it("skips broken symlinks while loading healthy and linked skills", () => {
    const file = writeSkill(workDir, ".agents");
    const skillsDir = dirname(dirname(file));
    symlinkSync(join(root, "missing"), join(skillsDir, "aaa-broken"));
    const linked = writeSkill(root, ".agents", "linked");
    symlinkSync(dirname(linked), join(skillsDir, "linked"));
    const catalog = new SkillCatalog();
    expect(() => {
      catalog.load(workDir);
    }).not.toThrow();
    expect(catalog.has("demo")).toBe(true);
    expect(catalog.has("linked")).toBe(true);
  });

  it("rereads files when mtime moves backwards and keeps a valid cache during bad writes", () => {
    const file = writeSkill(workDir, ".agents");
    const catalog = new SkillCatalog();
    catalog.load(workDir);
    writeFileSync(file, document("demo", "updated"));
    utimesSync(file, new Date(10_000), new Date(10_000));
    expect(catalog.get("demo")?.body).toBe("updated");
    writeFileSync(file, "---\nname: [");
    expect(catalog.get("demo")?.body).toBe("updated");
  });

  it("reindexes frontmatter renames without aliasing the old name", () => {
    const file = writeSkill(workDir, ".agents");
    const catalog = new SkillCatalog();
    catalog.load(workDir);
    writeFileSync(file, document("renamed"));
    utimesSync(file, new Date(10_000), new Date(10_000));
    expect(catalog.get("demo")).toBeUndefined();
    expect(catalog.has("demo")).toBe(false);
    expect(catalog.get("renamed")?.meta.name).toBe("renamed");
  });
});

describe("skill frontmatter and instructions", () => {
  it("supports BOM, CRLF, quoted names, and triple dashes within YAML values", () => {
    const raw =
      '\uFEFF---\r\nname: "quoted" # comment\r\ndescription: "before --- after"\r\n---\r\nBody\r\n---\r\nTail';
    expect(parseSkillFile(raw)).toMatchObject({
      meta: { name: "quoted", description: "before --- after" },
      body: "Body\r\n---\r\nTail",
    });
  });

  it.each([
    "---name: demo\n---\nbody",
    "---\nname: demo\n---oops\nbody",
    "prefix\n---\nname: demo\n---\nbody",
  ])("requires standalone frontmatter delimiters: %j", (raw) => {
    expect(parseSkillFile(raw)).toBeNull();
  });

  it("keeps unsupported allowed_tools as metadata without rejecting the skill", () => {
    expect(
      parseSkillFile(
        document().replace(
          "description:",
          "allowed_tools: ReadFile\ndescription:",
        ),
      ),
    ).toMatchObject({
      meta: { name: "demo" },
      frontmatter: { allowed_tools: "ReadFile" },
    });
  });

  it("advertises the actual install schema and emits one-line descriptions", () => {
    const file = writeSkill(workDir, ".agents");
    writeFileSync(
      file,
      document().replace(
        "description: Demo skill",
        "description: |\n  first line\n  second line",
      ),
    );
    const catalog = new SkillCatalog();
    catalog.load(workDir);
    const section = buildSkillSection(catalog, workDir);
    const tool = new InstallSkillTool(workDir, catalog);
    expect(tool.schema().input_schema.required).toEqual(["source"]);
    expect(section).toContain('{source: "<local path or raw SKILL.md URL>"}');
    expect(section).not.toContain("{url:");
    expect(section).toContain("GitHub tree/blob pages are not supported");
    expect(section).not.toContain("tools the Skill declares get registered");
    expect(section).toContain(
      "<name>demo</name><description>first line second line</description>",
    );
  });

  it("substitutes arguments literally in inline and fork skills", async () => {
    const skill: Skill = {
      meta: { name: "demo", description: "" },
      body: "Do $ARGUMENTS and $ARGUMENTS",
      sourceDir: "",
      isDirectory: false,
    };
    const activateSkill = vi.fn();
    const host: SkillForkHost = {
      activateSkill,
      snapshotParentMessages: vi.fn(),
      runSubagent: vi.fn((prompt: string) => Promise.resolve(prompt)),
    };
    const args = "$& $$ $` $'";
    const inline = runInline(skill, args, host);
    expect(inline).toContain(
      `<skill-body>\nDo ${args} and ${args}\n</skill-body>`,
    );
    expect(activateSkill).toHaveBeenCalledExactlyOnceWith("demo", inline);
    expect(await runFork(skill, args, host)).toBe(inline);
    expect(await runFork(skill, "", host)).toContain(
      "<skill-body>\nDo  and \n</skill-body>",
    );
    const fallback = await runFork(
      { ...skill, body: "Instructions" },
      "extra",
      host,
    );
    expect(fallback).toContain("<skill-body>\nInstructions\n</skill-body>");
    expect(fallback).toContain("<skill-arguments>extra</skill-arguments>");
  });
});

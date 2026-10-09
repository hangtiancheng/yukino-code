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
import { parseSkillPrompt, runFork, runInline } from "@/skills/executor.js";
import type { Skill, SkillForkHost, SkillHost } from "@/skills/index.js";
import { InstallSkillTool } from "@/skills/install-skill-tool.js";
import { LoadSkillTool } from "@/skills/load-skill-tool.js";

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof os>();
  return { ...actual, homedir: vi.fn(actual.homedir) };
});

let root: string;
let cwd: string;
let userDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "yukino-skills2-"));
  cwd = join(root, "project");
  userDir = join(root, "home");
  mkdirSync(cwd);
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
  const source = join(cwd, "source.md");
  writeFileSync(source, content);
  const catalog = new SkillCatalog();
  const onInstalled = vi.fn();
  const lookup = vi.fn(() =>
    Promise.resolve([{ address: "93.184.216.34", family: 4 }]),
  );
  const fetcher: typeof fetch = (input, init) => globalThis.fetch(input, init);
  const tool = new InstallSkillTool(cwd, catalog, onInstalled, {
    fetcher,
    lookup,
  });
  return { source, catalog, onInstalled, lookup, tool };
}

function makeHost() {
  const activated: [string, string][] = [];
  const host: SkillHost = {
    activateSkill: (n, b) => activated.push([n, b]),
  };
  return { host, activated };
}

function inlineSkill(body: string): Skill {
  return {
    meta: { name: "demo", description: "d" },
    body,
    sourceDir: "",
  };
}

describe("skill installation boundaries", () => {
  it("keeps explicitly declared skills in hidden directories while excluding hidden grouping directories", () => {
    writeSkill(userDir, ".yukino", ".declared");
    writeSkill(userDir, ".yukino", ".group/hidden");
    writeSkill(userDir, ".yukino", "node_modules/dependency");
    const catalog = new SkillCatalog();
    catalog.load(cwd);
    expect(catalog.list().map((skill) => skill.name)).toEqual([".declared"]);
  });

  it("requests write-tool approval in default mode and blocks installation in plan mode", () => {
    const { tool, source } = localInstaller();
    expect(tool.category).toBe("write");
    expect(
      new PermissionChecker(cwd).check(tool.name, tool.category, { source })
        .effect,
    ).toBe("ask");
    expect(
      new PermissionChecker(cwd, "plan").check(tool.name, tool.category, {
        source,
      }).effect,
    ).toBe("deny");
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
      const overridden = await tool.execute({ cwd }, { source, name });
      writeFileSync(source, document(name));
      const fromYaml = await tool.execute({ cwd }, { source });
      expect(overridden.isError).toBe(true);
      expect(fromYaml.isError).toBe(true);
      expect(existsSync(join(userDir, ".yukino"))).toBe(false);
      expect(catalog.list()).toEqual([]);
      expect(onInstalled).not.toHaveBeenCalled();
    },
  );

  it.each([
    ".yukino",
    ".yukino/skills",
    ".yukino/skills/demo",
    ".yukino/skills/demo/SKILL.md",
  ])("does not follow an installation symlink at %s", async (component) => {
    const { source, tool, onInstalled } = localInstaller();
    const outside = join(root, "outside");
    mkdirSync(outside);
    const protectedFile = join(outside, "SKILL.md");
    writeFileSync(protectedFile, "untouched");
    const link = join(userDir, component);
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(component.endsWith("SKILL.md") ? protectedFile : outside, link);
    const result = await tool.execute({ cwd }, { source });
    expect(result.isError).toBe(true);
    expect(readFileSync(protectedFile, "utf-8")).toBe("untouched");
    expect(readdirSync(outside)).toEqual(["SKILL.md"]);
    expect(onInstalled).not.toHaveBeenCalled();
  });

  it.each([".yukino", ".yukino/skills/demo/SKILL.md"])(
    "rejects a dangling symlink at %s",
    async (component) => {
      const { source, tool } = localInstaller();
      const link = join(userDir, component);
      mkdirSync(dirname(link), { recursive: true });
      const missing = join(root, "missing");
      symlinkSync(missing, link);
      expect((await tool.execute({ cwd }, { source })).isError).toBe(true);
      expect(existsSync(missing)).toBe(false);
    },
  );

  it("can install through a workspace alias without following child symlinks", async () => {
    const { source, catalog } = localInstaller();
    const alias = join(root, "project-alias");
    symlinkSync(cwd, alias);
    const result = await new InstallSkillTool(alias, catalog).execute(
      { cwd: alias },
      { source },
    );
    expect(result.isError).toBe(false);
    expect(catalog.has("demo")).toBe(true);
  });

  it("replaces a hard-linked destination without changing the other link", async () => {
    const { source, tool } = localInstaller();
    const file = writeSkill(userDir, ".yukino", "demo", "old");
    const outside = join(root, "outside.md");
    linkSync(file, outside);
    const old = readFileSync(outside, "utf-8");
    expect((await tool.execute({ cwd }, { source })).isError).toBe(false);
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
    const result = await tool.execute({ cwd }, { source, name: "renamed" });
    expect(result.isError).toBe(false);
    expect(catalog.has("renamed")).toBe(true);
    expect(catalog.has("demo")).toBe(false);
    const installed = readFileSync(
      join(userDir, ".yukino/skills/renamed/SKILL.md"),
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
      const file = writeSkill(userDir, ".yukino");
      const { tool, source, onInstalled } = localInstaller(content);
      const result = await tool.execute({ cwd }, { source, name: "demo" });
      expect(result.isError).toBe(true);
      expect(readFileSync(file, "utf-8")).toBe(document());
      expect(onInstalled).not.toHaveBeenCalled();
    },
  );

  it("returns tool errors for unreadable sources and invalid destination directories", async () => {
    const { source, tool } = localInstaller();
    expect((await tool.execute({ cwd }, { source: cwd })).isError).toBe(true);
    writeFileSync(join(userDir, ".yukino"), "keep me");
    expect((await tool.execute({ cwd }, { source })).isError).toBe(true);
    expect(readFileSync(join(userDir, ".yukino"), "utf-8")).toBe("keep me");
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
        { cwd, abortSignal: AbortSignal.abort() },
        { source },
      );
      expect(result.isError).toBe(true);
      expect(fetcher).not.toHaveBeenCalled();
      expect(onInstalled).not.toHaveBeenCalled();
      expect(existsSync(join(cwd, ".agents"))).toBe(false);
    },
  );

  it("aborts an in-flight fetch when its caller cancels", async () => {
    const { tool, onInstalled } = localInstaller();
    let receivedSignal: AbortSignal | null | undefined;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>((_input, init) => {
        receivedSignal = init?.signal;
        markStarted();
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
      { cwd, abortSignal: controller.signal },
      { source: "https://example.test/SKILL.md" },
    );
    await started;
    controller.abort();
    expect((await result).isError).toBe(true);
    expect(receivedSignal?.aborted).toBe(true);
    expect(onInstalled).not.toHaveBeenCalled();
    expect(existsSync(join(cwd, ".agents"))).toBe(false);
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
        { cwd },
        { source: "https://example.test/SKILL.md" },
      );
      await vi.advanceTimersByTimeAsync(30_000);
      expect((await result).isError).toBe(true);
      expect(receivedSignal?.aborted).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
      expect(onInstalled).not.toHaveBeenCalled();
      expect(existsSync(join(cwd, ".agents"))).toBe(false);
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
          { cwd, abortSignal: controller.signal },
          { source: "https://example.test/SKILL.md" },
        )
      ).isError,
    ).toBe(true);
    expect(existsSync(join(cwd, ".agents"))).toBe(false);
  });

  it("rejects streamed downloads larger than 1 MiB", async () => {
    const { tool, onInstalled } = localInstaller();
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(() =>
        Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new Uint8Array(600 * 1024));
                controller.enqueue(new Uint8Array(600 * 1024));
                controller.close();
              },
            }),
          ),
        ),
      ),
    );

    const result = await tool.execute(
      { cwd },
      { source: "https://example.test/SKILL.md" },
    );
    expect(result.isError).toBe(true);
    expect(result.output).toContain("1 MiB");
    expect(onInstalled).not.toHaveBeenCalled();
    expect(existsSync(join(cwd, ".agents"))).toBe(false);
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
    expect((await tool.execute({ cwd }, { source })).isError).toBe(false);
    expect(catalog.has("demo")).toBe(true);
    expect((await tool.execute({ cwd }, { source })).output).toContain("404");
    expect(onInstalled).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("skill download network boundaries", () => {
  it.each([
    "http://127.0.0.1/SKILL.md",
    "http://169.254.169.254/latest/meta-data",
    "http://[::1]/SKILL.md",
  ])("rejects literal non-public URL %s", async (source) => {
    const fetcher = vi.fn<typeof fetch>();
    const tool = new InstallSkillTool(cwd, new SkillCatalog(), undefined, {
      fetcher,
    });

    const result = await tool.execute({ cwd }, { source });

    expect(result.isError).toBe(true);
    expect(result.output).toContain("non-public network address");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects hostnames with any private DNS answer", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const lookup = vi.fn(() =>
      Promise.resolve([
        { address: "93.184.216.34", family: 4 },
        { address: "10.0.0.8", family: 4 },
      ]),
    );
    const tool = new InstallSkillTool(cwd, new SkillCatalog(), undefined, {
      fetcher,
      lookup,
    });

    const result = await tool.execute(
      { cwd },
      { source: "https://example.test/SKILL.md" },
    );

    expect(result.isError).toBe(true);
    expect(result.output).toContain("non-public network address");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("validates every redirect target before following it", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: { location: "http://127.0.0.1/SKILL.md" },
      }),
    );
    const lookup = vi.fn(() =>
      Promise.resolve([{ address: "93.184.216.34", family: 4 }]),
    );
    const tool = new InstallSkillTool(cwd, new SkillCatalog(), undefined, {
      fetcher,
      lookup,
    });

    const result = await tool.execute(
      { cwd },
      { source: "https://example.test/SKILL.md" },
    );

    expect(result.isError).toBe(true);
    expect(result.output).toContain("non-public network address");
    expect(fetcher).toHaveBeenCalledOnce();
  });
});

describe("skill catalog reload", () => {
  it("discovers grouped skills recursively, watches additions and stops at skill roots", () => {
    const group = join(cwd, ".agents", "skills", "group");
    const skill = join(group, "nested", "demo");
    mkdirSync(join(skill, "examples", "hidden"), { recursive: true });
    writeFileSync(join(skill, "SKILL.md"), document("nested"));
    writeFileSync(
      join(skill, "examples", "hidden", "SKILL.md"),
      document("example-only"),
    );
    const catalog = new SkillCatalog();
    catalog.load(cwd);
    expect(catalog.get("nested")?.sourceDir).toBe(skill);
    expect(catalog.has("example-only")).toBe(false);
    const another = join(group, "nested", "new");
    mkdirSync(another);
    writeFileSync(join(another, "SKILL.md"), document("new"));
    expect(catalog.needsReload()).toBe(true);
    catalog.reload();
    expect(catalog.has("new")).toBe(true);
  });

  it("terminates symlink cycles while preserving project-over-user precedence", () => {
    writeSkill(userDir, ".agents", "demo", "global");
    const grouped = join(cwd, ".agents", "skills", "group");
    mkdirSync(join(grouped, "demo"), { recursive: true });
    writeFileSync(
      join(grouped, "demo", "SKILL.md"),
      document("demo", "project"),
    );
    symlinkSync(dirname(grouped), join(grouped, "loop"));
    const catalog = new SkillCatalog();
    catalog.load(cwd);
    expect(catalog.list()).toHaveLength(1);
    expect(catalog.get("demo")?.body).toBe("project");
  });

  it.each([".agents"])(
    "watches project and user additions/removals in %s",
    (ecosystem) => {
      for (const base of [cwd, userDir]) {
        const catalog = new SkillCatalog();
        catalog.load(cwd);
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
    const dir = join(cwd, ".agents/skills/demo");
    mkdirSync(dir, { recursive: true });
    const catalog = new SkillCatalog();
    catalog.load(cwd);
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
    const preferred = writeSkill(cwd, ".agents", "demo", "project");
    const catalog = new SkillCatalog();
    catalog.load(cwd);
    expect(catalog.get("demo")?.body).toBe("project");
    rmSync(preferred);
    catalog.load(cwd);
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
    const file = writeSkill(cwd, ".agents");
    const skillsDir = dirname(dirname(file));
    symlinkSync(join(root, "missing"), join(skillsDir, "aaa-broken"));
    const linked = writeSkill(root, ".agents", "linked");
    symlinkSync(dirname(linked), join(skillsDir, "linked"));
    const catalog = new SkillCatalog();
    expect(() => {
      catalog.load(cwd);
    }).not.toThrow();
    expect(catalog.has("demo")).toBe(true);
    expect(catalog.has("linked")).toBe(true);
  });

  it("rereads files when mtime moves backwards and keeps a valid cache during bad writes", () => {
    const file = writeSkill(cwd, ".agents");
    const catalog = new SkillCatalog();
    catalog.load(cwd);
    writeFileSync(file, document("demo", "updated"));
    utimesSync(file, new Date(10_000), new Date(10_000));
    expect(catalog.get("demo")?.body).toBe("updated");
    writeFileSync(file, "---\nname: [");
    expect(catalog.get("demo")?.body).toBe("updated");
  });

  it("reindexes frontmatter renames without aliasing the old name", () => {
    const file = writeSkill(cwd, ".agents");
    const catalog = new SkillCatalog();
    catalog.load(cwd);
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
    const file = writeSkill(cwd, ".agents");
    writeFileSync(
      file,
      document().replace(
        "description: Demo skill",
        "description: |\n  first line\n  second line",
      ),
    );
    const catalog = new SkillCatalog();
    catalog.load(cwd);
    const section = buildSkillSection(catalog);
    const tool = new InstallSkillTool(cwd, catalog);
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

describe("skills runInline", () => {
  it("substitutes $ARGUMENTS and activates the skill", () => {
    const { host, activated } = makeHost();
    const body = runInline(
      inlineSkill("Do $ARGUMENTS now."),
      "the thing",
      host,
    );

    expect(body).toContain("<skill-body>\nDo the thing now.\n</skill-body>");
    expect(activated).toEqual([["demo", body]]);
  });

  it("keeps user arguments separate when there is no placeholder", () => {
    const { host } = makeHost();
    const body = runInline(inlineSkill("SOP body"), "extra context", host);
    expect(body).toContain("<skill-body>\nSOP body\n</skill-body>");
    expect(body).toContain("<skill-arguments>extra context</skill-arguments>");
  });
});

describe("skill prompt display parsing", () => {
  it.each([
    "",
    "Update <docs> & keep &lt; literal\nSecond line",
    "</skill-body>\n$&",
  ])("round-trips arguments without changing the prompt: %s", (args) => {
    const { host, activated } = makeHost();
    const definition: Skill = {
      ...inlineSkill("Before\n</skill-body>\nAfter $ARGUMENTS\n"),
      meta: { name: "demo<&lt;>", description: "d" },
      sourceDir: "/project/<skills>&lt;",
    };
    const prompt = runInline(definition, args, host);
    expect(parseSkillPrompt(prompt)).toEqual({
      name: definition.meta.name,
      directory: definition.sourceDir,
      body: `Before\n</skill-body>\nAfter ${args}\n`,
      args,
    });
    expect(activated).toEqual([[definition.meta.name, prompt]]);
  });

  it("parses an empty body without inventing arguments", () => {
    const { host } = makeHost();
    expect(parseSkillPrompt(runInline(inlineSkill(""), "", host))).toEqual({
      name: "demo",
      directory: "",
      body: "",
      args: "",
    });
  });

  it("leaves ordinary, quoted and incomplete skill markup as user text", () => {
    const { host } = makeHost();
    const prompt = runInline(inlineSkill("SOP body"), "extra context", host);
    for (const text of [
      "/demo extra context",
      "Explain <skill-body>markup</skill-body>",
      `Quoted:\n${prompt}`,
      prompt.replace("</skill-metadata>", ""),
      prompt.replace("</skill-arguments>", ""),
      `${prompt}\nExtra user text`,
    ]) {
      expect(parseSkillPrompt(text)).toBeUndefined();
    }
  });
});

describe("LoadSkillTool fork mode", () => {
  function forkFixture(mode: "inline" | "fork") {
    const calls: string[] = [];
    const signals: (AbortSignal | undefined)[] = [];
    const activated: string[] = [];
    const catalog = new SkillCatalog();
    vi.spyOn(catalog, "get").mockReturnValue({
      meta: { name: "audit-deps", description: "d", mode },
      body: "Inspect package.json and flag risky pins.",
      sourceDir: "",
    });
    vi.spyOn(catalog, "list").mockReturnValue([
      { name: "audit-deps", description: "d" },
    ]);

    const host: SkillHost = { activateSkill: (n) => activated.push(n) };
    const forkHost: SkillForkHost = {
      activateSkill: (n) => activated.push(n),
      snapshotParentMessages: () => "",
      runSubagent: async (prompt, abortSignal) => {
        calls.push(prompt);
        signals.push(abortSignal);
        return Promise.resolve("3 risky pins found");
      },
    };
    return { catalog, host, forkHost, calls, signals, activated };
  }

  it("runs a fork skill in a sub-agent and keeps the SOP out of the main context", async () => {
    const { catalog, host, forkHost, calls, activated } = forkFixture("fork");

    const tool = new LoadSkillTool(catalog, host, forkHost);

    const res = await tool.execute(
      { cwd: process.cwd() },
      { name: "audit-deps" },
    );

    expect(res.isError).toBe(false);
    expect(res.output).toBe("3 risky pins found");
    expect(res.output).not.toContain("Inspect package.json");
    expect(calls[0]).toContain("Inspect package.json");
    expect(activated).toHaveLength(0);
  });

  it("passes the active tool cancellation signal to a forked skill", async () => {
    const { catalog, host, forkHost, signals } = forkFixture("fork");
    const controller = new AbortController();
    const tool = new LoadSkillTool(catalog, host, forkHost);

    await tool.execute(
      { cwd: process.cwd(), abortSignal: controller.signal },
      { name: "audit-deps" },
    );

    expect(signals).toEqual([controller.signal]);
  });

  it("falls back to inline when no fork host is wired", async () => {
    const { catalog, host } = forkFixture("fork");

    const tool = new LoadSkillTool(catalog, host);

    const res = await tool.execute(
      { cwd: process.cwd() },
      { name: "audit-deps" },
    );

    expect(res.isError).toBe(false);
    expect(res.output).toContain("Inspect package.json");
  });

  it("does not spawn a sub-agent for inline skills", async () => {
    const { catalog, host, forkHost, calls } = forkFixture("inline");

    const tool = new LoadSkillTool(catalog, host, forkHost);

    const res = await tool.execute(
      { cwd: process.cwd() },
      { name: "audit-deps" },
    );

    expect(res.output).toContain("Inspect package.json");
    expect(calls).toHaveLength(0);
  });
});

describe("skill frontmatter mode resolution", () => {
  it("treats context: fork as mode: fork", () => {
    const dir = mkdtempSync(join(tmpdir(), "yukino-skill-"));
    const skillDir = join(dir, ".agents", "skills", "audit-deps");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      "---\nname: audit-deps\ndescription: Audit dependencies\ncontext: fork\n---\n\nbody",
    );

    const catalog = new SkillCatalog();
    catalog.load(dir);

    expect(catalog.get("audit-deps")?.meta.mode).toBe("fork");
  });

  it("keeps an explicit mode over the legacy context field", () => {
    const dir = mkdtempSync(join(tmpdir(), "yukino-skill-"));
    const skillDir = join(dir, ".agents", "skills", "audit-deps");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      "---\nname: audit-deps\ndescription: Audit\nmode: inline\ncontext: fork\n---\n\nbody",
    );

    const catalog = new SkillCatalog();
    catalog.load(dir);

    expect(catalog.get("audit-deps")?.meta.mode).toBe("inline");
  });
});

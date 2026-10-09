import { existsSync } from "node:fs";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { githubModule } from "@/tools/github/tool.js";
import { firstText, isolateEnv, makeTempDir, writeFakeGh } from "../helpers.js";

const envKeys = [
  "PATH",
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "GITHUB_BASE_URL",
  "GH_HOST",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
];
isolateEnv(envKeys);
let client: Client;
let executableDir: string;
const resultSchema = z.object({
  content: z.array(z.unknown()),
  structuredContent: z.record(z.string(), z.unknown()).optional(),
  isError: z.boolean().optional(),
});
async function call(args: Record<string, unknown>) {
  return resultSchema.parse(
    await client.callTool({ name: "github_tool", arguments: args }),
  );
}
beforeEach(async () => {
  for (const key of envKeys) delete process.env[key];
  executableDir = makeTempDir();
  process.env["PATH"] = executableDir;
  const server = new McpServer({ name: "test", version: "1" });
  githubModule.register(server);
  const [a, b] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "test", version: "1" });
  await Promise.all([client.connect(a), server.connect(b)]);
});
afterEach(async () => {
  await client.close();
});

describe("github_tool", () => {
  it("publishes one unrestricted tool without checking authentication", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(["github_tool"]);
    expect(tools[0].annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
    });
  });

  it.each(["repo", "issue", "pr", "run", "release", "project", "api"])(
    "passes %s commands and flags through unchanged",
    async (command) => {
      writeFakeGh(executableDir, 'printf "%s\\n" "$@"');
      const args = [command, "--repo", "owner/repo", "--json", "number,title"];
      const result = await call({ args });
      expect(result.isError).toBeUndefined();
      expect(result.structuredContent).toMatchObject({
        stdout: args.join("\n") + "\n",
        stderr: "",
        exit_code: 0,
        signal: null,
        timed_out: false,
        cancelled: false,
      });
      expect(JSON.parse(firstText(result))).toEqual(result.structuredContent);
    },
  );

  it("preserves argument boundaries and shell syntax literally", async () => {
    writeFakeGh(
      executableDir,
      'for arg in "$@"; do printf "[%s]\\n" "$arg"; done',
    );
    const marker = path.join(makeTempDir(), "must-not-exist");
    const body = `hello world; $(/usr/bin/touch ${marker})`;
    const result = await call({
      args: ["issue", "create", "--title", "title with spaces", "--body", body],
    });
    expect(result.structuredContent?.["stdout"]).toContain(`[${body}]`);
    expect(existsSync(marker)).toBe(false);
  });

  it("passes multiline JSON through stdin for arbitrary REST operations", async () => {
    writeFakeGh(executableDir, "/bin/cat");
    const stdin =
      '{\n  "labels": [],\n  "enabled": false,\n  "value": null\n}\n';
    const result = await call({
      args: ["api", "repos/o/r/issues/7", "--method", "PATCH", "--input", "-"],
      stdin,
    });
    expect(result.structuredContent?.["stdout"]).toBe(stdin);
  });

  it("supports GraphQL and pagination flags without a separate tool", async () => {
    writeFakeGh(executableDir, 'printf "%s\\n" "$@"');
    const args = [
      "api",
      "graphql",
      "--paginate",
      "--slurp",
      "-f",
      "query=query($endCursor: String) { viewer { repositories(first: 10, after: $endCursor) { nodes { name } pageInfo { hasNextPage endCursor } } } }",
    ];
    const result = await call({ args });
    expect(result.structuredContent?.["stdout"]).toBe(args.join("\n") + "\n");
  });

  it("runs in the caller-selected repository directory", async () => {
    writeFakeGh(executableDir, "/bin/pwd -P");
    const cwd = makeTempDir();
    const result = await call({ args: ["pr", "checkout", "7"], cwd });
    expect(String(result.structuredContent?.["stdout"]).trim()).toBe(
      cwd.replace(/^\/var\//, "/private/var/"),
    );
  });

  it("passes configured tokens to gh and disables interactive prompts", async () => {
    process.env["GITHUB_TOKEN"] = "test-token";
    writeFakeGh(
      executableDir,
      'test "$GH_TOKEN" = "test-token" && test "$GH_PROMPT_DISABLED" = "1" && test "$GH_PAGER" = "cat"',
    );
    expect((await call({ args: ["api", "user"] })).isError).toBeUndefined();
  });

  it("preserves native GH_TOKEN precedence and Enterprise credentials", async () => {
    process.env["GITHUB_TOKEN"] = "fallback";
    process.env["GH_TOKEN"] = "native";
    process.env["GH_HOST"] = "ghe.example.com";
    process.env["GH_ENTERPRISE_TOKEN"] = "enterprise";
    writeFakeGh(
      executableDir,
      'test "$GH_TOKEN" = "native" && test "$GH_HOST" = "ghe.example.com" && test "$GH_ENTERPRISE_TOKEN" = "enterprise"',
    );
    expect((await call({ args: ["api", "user"] })).isError).toBeUndefined();
  });

  it("maps legacy Enterprise base URLs to gh's host and token environment", async () => {
    process.env["GITHUB_BASE_URL"] = "https://ghe.example.com/api/v3";
    process.env["GITHUB_TOKEN"] = "test-token";
    writeFakeGh(
      executableDir,
      'test "$GH_HOST" = "ghe.example.com" && test "$GH_ENTERPRISE_TOKEN" = "test-token"',
    );
    expect((await call({ args: ["api", "user"] })).isError).toBeUndefined();
  });

  it("retains stdout and stderr on nonzero exits instead of reporting success", async () => {
    writeFakeGh(
      executableDir,
      'printf "partial result"; printf "HTTP 403: forbidden" >&2; exit 1',
    );
    const result = await call({ args: ["api", "user"] });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      stdout: "partial result",
      stderr: "HTTP 403: forbidden",
      exit_code: 1,
      timed_out: false,
    });
  });

  it("preserves binary stdout with base64 encoding", async () => {
    writeFakeGh(executableDir, "printf '\\000\\377\\001'");
    const result = await call({
      args: ["api", "repos/o/r/actions/artifacts/1/zip"],
      response_format: "base64",
    });
    expect(result.structuredContent?.["stdout"]).toBe("AP8B");
  });

  it("reports missing gh with installation and authentication instructions", async () => {
    const result = await call({ args: ["api", "user"] });
    expect(result.isError).toBe(true);
    expect(firstText(result)).toContain("Install GitHub CLI");
    expect(firstText(result)).toContain("gh auth login");
  });

  it("terminates timed-out commands", async () => {
    writeFakeGh(executableDir, 'printf "started"; exec /bin/sleep 60');
    const result = await call({ args: ["run", "watch", "1"], timeout_ms: 100 });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      timed_out: true,
      exit_code: null,
      signal: "SIGKILL",
    });
  });

  it("rejects missing arguments before spawning a process", async () => {
    writeFakeGh(executableDir, 'printf "should not execute"');
    expect((await call({ args: [] })).isError).toBe(true);
  });
});

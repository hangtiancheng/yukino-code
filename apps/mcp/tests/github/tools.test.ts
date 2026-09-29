// Tool-level tests for the github module: registration, backend gating
// (gh CLI vs token), argument schemas and result shapes.
//
// The tools run through a real McpServer + in-memory MCP client, so the SDK
// (schema publication, argument validation, result envelope) is covered too.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { githubModule } from "@/tools/github/tool.js";

import {
  firstText,
  isolateEnv,
  makeTempDir,
  stubFetchRoutes,
  writeFakeGh,
} from "../helpers.js";

const API_BASE = "https://api.github.com";
const TOKEN = "tok-secret";
const REPO = "hangtiancheng/yukino-code";

const EXPECTED_TOOLS = [
  "github_create_branch",
  "github_create_issue",
  "github_create_or_update_file",
  "github_create_pull_request",
  "github_create_repo",
  "github_get_repo",
  "github_list_branches",
  "github_list_commits",
  "github_list_issues",
  "github_list_pull_requests",
  "github_list_tags",
  "github_list_tree",
  "github_read_file",
  "github_search_code",
  "github_search_repositories",
];

isolateEnv(["PATH", "GITHUB_TOKEN", "GH_TOKEN", "GITHUB_BASE_URL"]);

let client: Client;

beforeEach(async () => {
  // PATH contains only an empty dir: `gh` resolves nowhere, so the
  // developer's real gh login never leaks into these tests.
  process.env["PATH"] = makeTempDir();
  delete process.env["GITHUB_TOKEN"];
  delete process.env["GH_TOKEN"];
  delete process.env["GITHUB_BASE_URL"];

  const server = new McpServer({ name: "test", version: "0.0.0" });
  githubModule.register(server);
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  client = new Client({ name: "vitest", version: "0.0.0" });
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);
});

afterEach(async () => {
  await client.close();
});

function configureToken(token: string = TOKEN): void {
  process.env["GITHUB_TOKEN"] = token;
}

// The SDK's call result is a union (task-based results carry `toolResult`
// instead of `content`) with index signatures that defeat `in` narrowing, so
// the shape the tests rely on is validated with zod.
const ToolResultSchema = z.object({
  content: z.array(z.unknown()),
  isError: z.boolean().optional(),
  structuredContent: z.record(z.string(), z.unknown()).optional(),
});
type ToolResult = z.infer<typeof ToolResultSchema>;

async function callTool(
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const result = await client.callTool({ name, arguments: args });
  return ToolResultSchema.parse(result);
}

const InputSchemaSchema = z.object({
  properties: z.record(z.string(), z.unknown()).optional(),
  required: z.array(z.string()).optional(),
});

function parseInputSchema(raw: unknown): {
  properties: Record<string, unknown>;
  required: string[];
} {
  const parsed = InputSchemaSchema.parse(raw);
  return {
    properties: parsed.properties ?? {},
    required: parsed.required ?? [],
  };
}

describe("registration", () => {
  it("registers the full github tool suite", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(EXPECTED_TOOLS);
  });

  it("tools are unavailable without gh or a token", async () => {
    const result = await callTool("github_read_file", {
      repo: REPO,
      file_path: "r.md",
    });

    expect(result.isError).toBe(true);
    const text = firstText(result);
    expect(text).toContain("GITHUB_TOKEN");
    expect(text).toContain("gh auth login");
  });
});

describe("backend gating", () => {
  it("read_file uses the token transport when gh is unavailable", async () => {
    configureToken();
    const fetchStub = stubFetchRoutes([
      {
        method: "GET",
        url: `${API_BASE}/repos/${REPO}`,
        json: { default_branch: "main" },
      },
      {
        method: "GET",
        url: `${API_BASE}/repos/${REPO}/contents/readme.md`,
        json: {
          type: "file",
          encoding: "base64",
          content: Buffer.from("hello world").toString("base64"),
          size: 11,
        },
      },
    ]);

    const result = await callTool("github_read_file", {
      repo: REPO,
      file_path: "readme.md",
    });

    expect(result.isError).toBeUndefined();
    expect(firstText(result)).toBe("hello world");
    expect(result.structuredContent).toEqual({
      repo: REPO,
      file_path: "readme.md",
      ref: null,
      size: 11,
      type: "file",
    });
    // The configured token is the one that reaches GitHub.
    expect(fetchStub.lastCall().headers["authorization"]).toBe(
      `Bearer ${TOKEN}`,
    );
  });

  it("read_file prefers the gh CLI over the token", async () => {
    const dir = makeTempDir();
    writeFakeGh(
      dir,
      `if [ "$1" = "auth" ]; then exit 0; fi
for last in "$@"; do :; done
case "$last" in
  */contents/*) printf '{"type":"file","encoding":"base64","content":"aGVsbG8=","size":5}' ;;
  *) printf '{"default_branch":"main"}' ;;
esac`,
    );
    process.env["PATH"] = dir;
    configureToken(); // present, but the gh CLI must win
    const fetchStub = stubFetchRoutes([]);

    const result = await callTool("github_read_file", {
      repo: REPO,
      file_path: "readme.md",
    });

    expect(result.isError).toBeUndefined();
    expect(firstText(result)).toBe("hello");
    // Nothing went over HTTP: the gh CLI handled the whole call.
    expect(fetchStub.calls).toEqual([]);
  });
});

describe("result formatting", () => {
  it("list_tree formats flattened entries", async () => {
    configureToken();
    stubFetchRoutes([
      {
        method: "GET",
        url: `${API_BASE}/repos/${REPO}/git/trees/main`,
        json: {
          truncated: false,
          tree: [
            { path: "src", type: "tree", sha: "s1" },
            { path: "src/index.ts", type: "blob", sha: "s2", size: 10 },
          ],
        },
      },
    ]);

    const result = await callTool("github_list_tree", {
      repo: REPO,
      ref: "main",
    });

    expect(result.isError).toBeUndefined();
    expect(firstText(result)).toBe("📁 src\n📄 src/index.ts");
    expect(result.structuredContent).toEqual({
      repo: REPO,
      path: "",
      ref: "main",
      count: 2,
    });
  });

  it("list_commits formats entries", async () => {
    configureToken();
    stubFetchRoutes([
      {
        method: "GET",
        url: `${API_BASE}/repos/${REPO}/commits`,
        json: [
          {
            sha: "a".repeat(40),
            commit: {
              message: "feat: x",
              author: { name: "A", date: "2026-09-18T10:00:00Z" },
            },
          },
        ],
      },
    ]);

    const result = await callTool("github_list_commits", {
      repo: REPO,
      ref: "main",
    });

    expect(result.isError).toBeUndefined();
    expect(firstText(result)).toBe(
      `${"a".repeat(8)}  2026-09-18 10:00:00  A  feat: x`,
    );
    expect(result.structuredContent).toEqual({
      repo: REPO,
      ref: "main",
      count: 1,
    });
  });

  it("list_branches formats default and protected", async () => {
    configureToken();
    stubFetchRoutes([
      {
        method: "GET",
        url: `${API_BASE}/repos/${REPO}`,
        json: { default_branch: "main" },
      },
      {
        method: "GET",
        url: `${API_BASE}/repos/${REPO}/branches`,
        json: [
          { name: "main", protected: true },
          { name: "dev/0.0.1", protected: false },
        ],
      },
    ]);

    const result = await callTool("github_list_branches", { repo: REPO });

    expect(result.isError).toBeUndefined();
    expect(firstText(result)).toBe("* main (protected)\n  dev/0.0.1");
    expect(result.structuredContent).toEqual({ repo: REPO, count: 2 });
  });

  it("create_repo reports URLs", async () => {
    configureToken();
    const fetchStub = stubFetchRoutes([
      {
        method: "POST",
        url: `${API_BASE}/user/repos`,
        status: 201,
        json: {
          id: 812345,
          name: "repo",
          full_name: "octocat/repo",
          private: true,
          html_url: "https://github.com/octocat/repo",
          clone_url: "https://github.com/octocat/repo.git",
          ssh_url: "git@github.com:octocat/repo.git",
        },
      },
    ]);

    const result = await callTool("github_create_repo", {
      name: "repo",
      private: true,
    });

    expect(result.isError).toBeUndefined();
    const text = firstText(result);
    expect(text).toContain("Created octocat/repo (id 812345)");
    expect(text).toContain("web:  https://github.com/octocat/repo");
    expect(text).toContain("http: https://github.com/octocat/repo.git");
    expect(JSON.parse(fetchStub.lastCall().body ?? "")).toEqual({
      name: "repo",
      private: true,
    });
    expect(result.structuredContent).toMatchObject({ id: 812345 });
  });

  it("API errors surface as error results", async () => {
    configureToken();
    stubFetchRoutes([
      {
        method: "GET",
        url: `${API_BASE}/repos/${REPO}`,
        status: 404,
        json: { message: "Not Found" },
      },
    ]);

    const result = await callTool("github_list_branches", { repo: REPO });

    expect(result.isError).toBe(true);
    expect(firstText(result)).toContain("404");
  });

  it("get_repo formats metadata", async () => {
    configureToken();
    stubFetchRoutes([
      {
        method: "GET",
        url: `${API_BASE}/repos/${REPO}`,
        json: {
          id: 42,
          name: "yukino-code",
          full_name: REPO,
          description: "demo",
          private: false,
          default_branch: "main",
          language: "TypeScript",
          stargazers_count: 7,
          forks_count: 2,
          open_issues_count: 3,
          html_url: `https://github.com/${REPO}`,
        },
      },
    ]);

    const result = await callTool("github_get_repo", { repo: REPO });

    expect(result.isError).toBeUndefined();
    const text = firstText(result);
    expect(text).toContain(`${REPO} (id 42)`);
    expect(text).toContain("stars: 7");
    expect(result.structuredContent).toMatchObject({ default_branch: "main" });
  });

  it("search_code lists repository and path", async () => {
    configureToken();
    const fetchStub = stubFetchRoutes([
      {
        method: "GET",
        url: `${API_BASE}/search/code`,
        json: {
          total_count: 1,
          items: [{ path: "src/index.ts", repository: { full_name: REPO } }],
        },
      },
    ]);

    const result = await callTool("github_search_code", {
      query: `TODO repo:${REPO}`,
    });

    expect(result.isError).toBeUndefined();
    expect(firstText(result)).toBe(`${REPO}  src/index.ts`);
    expect(fetchStub.lastCall().searchParams["q"]).toBe(`TODO repo:${REPO}`);
  });

  it("list_issues skips pull requests", async () => {
    configureToken();
    stubFetchRoutes([
      {
        method: "GET",
        url: `${API_BASE}/repos/${REPO}/issues`,
        json: [
          {
            number: 7,
            title: "bug",
            state: "open",
            user: { login: "octo" },
            labels: [{ name: "p0" }],
            created_at: "2026-09-01T00:00:00Z",
          },
          { number: 8, title: "pr", state: "open", pull_request: {} },
        ],
      },
    ]);

    const result = await callTool("github_list_issues", { repo: REPO });

    expect(result.isError).toBeUndefined();
    expect(firstText(result)).toBe("#7 [open] bug [p0] by octo on 2026-09-01");
    expect(result.structuredContent).toMatchObject({ count: 1 });
  });

  it("create_issue posts title and labels", async () => {
    configureToken();
    const fetchStub = stubFetchRoutes([
      {
        method: "POST",
        url: `${API_BASE}/repos/${REPO}/issues`,
        status: 201,
        json: {
          number: 9,
          title: "bug",
          state: "open",
          html_url: `https://github.com/${REPO}/issues/9`,
        },
      },
    ]);

    const result = await callTool("github_create_issue", {
      repo: REPO,
      title: "bug",
      labels: ["p0"],
    });

    expect(result.isError).toBeUndefined();
    expect(firstText(result)).toContain("Created issue #9: bug");
    expect(JSON.parse(fetchStub.lastCall().body ?? "")).toEqual({
      title: "bug",
      labels: ["p0"],
    });
    expect(result.structuredContent).toMatchObject({ number: 9 });
  });

  it("create_branch resolves the default branch and posts the ref", async () => {
    configureToken();
    const fetchStub = stubFetchRoutes([
      {
        method: "GET",
        url: `${API_BASE}/repos/${REPO}`,
        json: { default_branch: "main" },
      },
      {
        method: "GET",
        url: `${API_BASE}/repos/${REPO}/commits/main`,
        json: { sha: "b".repeat(40) },
      },
      {
        method: "POST",
        url: `${API_BASE}/repos/${REPO}/git/refs`,
        status: 201,
        json: {
          ref: "refs/heads/feature",
          object: { sha: "b".repeat(40) },
        },
      },
    ]);

    const result = await callTool("github_create_branch", {
      repo: REPO,
      branch: "feature",
    });

    expect(result.isError).toBeUndefined();
    expect(firstText(result)).toBe(
      `Created refs/heads/feature at ${"b".repeat(8)}`,
    );
    expect(JSON.parse(fetchStub.lastCall().body ?? "")).toEqual({
      ref: "refs/heads/feature",
      sha: "b".repeat(40),
    });
  });

  it("create_or_update_file creates on 404", async () => {
    configureToken();
    const fetchStub = stubFetchRoutes([
      {
        method: "GET",
        url: `${API_BASE}/repos/${REPO}`,
        json: { default_branch: "main" },
      },
      {
        method: "GET",
        url: `${API_BASE}/repos/${REPO}/contents/docs/notes.md`,
        status: 404,
        json: { message: "Not Found" },
      },
      {
        method: "PUT",
        url: `${API_BASE}/repos/${REPO}/contents/docs/notes.md`,
        status: 201,
        json: {
          content: {
            sha: "newblob",
            html_url: `https://github.com/${REPO}/blob/main/docs/notes.md`,
          },
          commit: { sha: "c".repeat(40) },
        },
      },
    ]);

    const result = await callTool("github_create_or_update_file", {
      repo: REPO,
      file_path: "docs/notes.md",
      content: "hello",
      message: "add notes",
    });

    expect(result.isError).toBeUndefined();
    expect(firstText(result)).toMatch(/^Created docs\/notes\.md/);
    const body = z
      .object({
        message: z.string(),
        content: z.string(),
        branch: z.string(),
        sha: z.string().optional(),
      })
      .parse(JSON.parse(fetchStub.lastCall().body ?? ""));
    expect(body.message).toBe("add notes");
    expect(Buffer.from(body.content, "base64").toString("utf-8")).toBe("hello");
    expect(body.branch).toBe("main");
    expect(body.sha).toBeUndefined(); // creation, not an update
    expect(result.structuredContent).toMatchObject({ created: true });
  });
});

describe("argument validation", () => {
  it("invalid arguments produce an error result", async () => {
    configureToken();

    // per_page above the declared maximum must fail validation, not the call.
    // The SDK surfaces the protocol error to the agent as an isError result.
    const result = await callTool("github_list_commits", {
      repo: REPO,
      per_page: 999,
    });

    expect(result.isError).toBe(true);
    expect(firstText(result)).toContain("Invalid arguments");
  });

  it("input schemas use the published wire names", async () => {
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((tool) => [tool.name, tool]));

    const readFile = byName.get("github_read_file");
    expect(readFile).toBeDefined();
    const readFileSchema = parseInputSchema(readFile?.inputSchema);
    expect(Object.keys(readFileSchema.properties).sort()).toEqual([
      "file_path",
      "ref",
      "repo",
    ]);
    expect(readFileSchema.required).toEqual(["repo", "file_path"]);
    expect(readFile?.annotations?.readOnlyHint).toBe(true);

    const createRepo = byName.get("github_create_repo");
    expect(createRepo?.annotations?.readOnlyHint).toBe(false);
    expect(
      Object.keys(parseInputSchema(createRepo?.inputSchema).properties).sort(),
    ).toEqual(["description", "name", "owner", "private"]);

    // The state filter is a closed enum, published in the schema.
    const listIssues = byName.get("github_list_issues");
    const stateSchema = z
      .object({ enum: z.array(z.string()) })
      .parse(parseInputSchema(listIssues?.inputSchema).properties["state"]);
    expect(stateSchema.enum).toEqual(["open", "closed", "all"]);

    // Writing a file is flagged destructive; creating a branch is not.
    const writeFile = byName.get("github_create_or_update_file");
    expect(writeFile?.annotations?.readOnlyHint).toBe(false);
    expect(writeFile?.annotations?.destructiveHint).toBe(true);
    const writeFileSchema = parseInputSchema(writeFile?.inputSchema);
    expect(Object.keys(writeFileSchema.properties).sort()).toEqual([
      "branch",
      "content",
      "file_path",
      "message",
      "repo",
    ]);
    expect(writeFileSchema.required).toEqual([
      "repo",
      "file_path",
      "content",
      "message",
    ]);

    const createBranch = byName.get("github_create_branch");
    expect(createBranch?.annotations?.destructiveHint).toBe(false);
    expect(createBranch?.annotations?.readOnlyHint).toBe(false);
  });
});

describe("lenient boolean arguments", () => {
  // Some MCP clients stringify JSON booleans ("false" instead of false); the
  // tools must accept the string spellings and normalize them to real
  // booleans before anything reaches the GitHub API.

  it("create_repo coerces stringified booleans before hitting the API", async () => {
    configureToken();
    const fetchStub = stubFetchRoutes([
      {
        method: "POST",
        url: `${API_BASE}/user/repos`,
        status: 201,
        json: { id: 1, name: "repo", full_name: "octocat/repo" },
      },
    ]);

    for (const [wire, expected] of [
      ["false", false],
      ["true", true],
    ] as const) {
      const result = await callTool("github_create_repo", {
        name: "repo",
        private: wire,
      });

      expect(result.isError).toBeUndefined();
      // GitHub receives a real JSON boolean, not the client's string.
      expect(JSON.parse(fetchStub.lastCall().body ?? "")).toEqual({
        name: "repo",
        private: expected,
      });
    }
  });

  it("create_pull_request coerces a stringified draft flag", async () => {
    configureToken();
    const fetchStub = stubFetchRoutes([
      {
        method: "POST",
        url: `${API_BASE}/repos/${REPO}/pulls`,
        status: 201,
        json: { number: 3, title: "t", state: "open" },
      },
    ]);

    const draft = await callTool("github_create_pull_request", {
      repo: REPO,
      title: "t",
      head: "feature",
      draft: "true",
    });
    expect(draft.isError).toBeUndefined();
    expect(JSON.parse(fetchStub.lastCall().body ?? "")).toEqual({
      title: "t",
      head: "feature",
      draft: true,
    });

    // "false" normalizes to a real false, which the client omits.
    await callTool("github_create_pull_request", {
      repo: REPO,
      title: "t",
      head: "feature",
      draft: "false",
    });
    expect(JSON.parse(fetchStub.lastCall().body ?? "")).toEqual({
      title: "t",
      head: "feature",
    });
  });

  it("strings that are not boolean spellings stay invalid", async () => {
    configureToken();

    const result = await callTool("github_create_repo", {
      name: "repo",
      private: "yes",
    });

    expect(result.isError).toBe(true);
    expect(firstText(result)).toContain("Invalid arguments");
  });

  it("the published schema still advertises the boolean type", async () => {
    const { tools } = await client.listTools();
    const createRepo = tools.find((tool) => tool.name === "github_create_repo");
    const privateSchema = parseInputSchema(createRepo?.inputSchema).properties[
      "private"
    ];

    // boolean | "true" | "false" (+ null): the boolean branch must survive
    // the zod -> JSON Schema conversion.
    expect(JSON.stringify(privateSchema)).toContain('"boolean"');
  });
});

describe("custom base URL", () => {
  it("is honoured by the HTTP transport", async () => {
    // GITHUB_BASE_URL points the HTTP transport at any GitHub-compatible API
    // (e.g. GitHub Enterprise Server).
    configureToken();
    process.env["GITHUB_BASE_URL"] = "https://ghe.example.com/api/v3/";

    const fetchStub = stubFetchRoutes([
      {
        method: "GET",
        url: "https://ghe.example.com/api/v3/repos/g/p",
        json: { default_branch: "main" },
      },
      {
        method: "GET",
        url: "https://ghe.example.com/api/v3/repos/g/p/contents/f.txt",
        json: {
          type: "file",
          encoding: "base64",
          content: Buffer.from("x").toString("base64"),
          size: 1,
        },
      },
    ]);

    const result = await callTool("github_read_file", {
      repo: "g/p",
      file_path: "f.txt",
    });

    expect(result.isError).toBeUndefined();
    expect(
      fetchStub.calls.filter((call) => call.url.includes("/contents/f.txt")),
    ).toHaveLength(1);
  });
});

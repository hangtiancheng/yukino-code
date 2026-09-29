// GitHub client behaviour: endpoint mapping, payload normalization and the
// two transports (an authenticated `gh` CLI subprocess vs bearer-token HTTP).
//
// The gh CLI is exercised through a fake `gh` shell script on PATH, so the
// tests cover the real subprocess plumbing without touching the network or
// the developer's own gh login.

import { createServer, type Server } from "node:http";

import { describe, expect, it } from "vitest";

import {
  isolateEnv,
  makeTempDir,
  stubFetchRoutes,
  writeFakeGh,
} from "../helpers.js";

import {
  GitHubClient,
  encodeRepo,
  validateBranchName,
} from "@/tools/github/client.js";
import {
  DEFAULT_API_BASE_URL,
  GhCliTransport,
  GitHubError,
  HttpTransport,
  ghCliIsAvailable,
  resolveTransport,
  type GitHubRequestOptions,
  type GitHubTransport,
} from "@/tools/github/transport.js";

const REPO = "hangtiancheng/yukino-code";

interface RecordedRequest {
  method: string;
  apiPath: string;
  query: Record<string, string | number> | null;
  jsonBody: Record<string, unknown> | null;
}

/** Returns canned responses in order and records every request. */
class FakeTransport implements GitHubTransport {
  requests: RecordedRequest[] = [];
  responses: unknown[] = [];
  /** "METHOD path" pairs that answer with a GitHubError. */
  raiseOn = new Set<string>();
  /** Per-path GitHubError status for raiseOn entries (default 403). */
  statusFor = new Map<string, number>();

  enqueue(response: unknown): void {
    this.responses.push(response);
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async request(
    method: string,
    apiPath: string,
    options?: GitHubRequestOptions,
  ): Promise<unknown> {
    this.requests.push({
      method,
      apiPath,
      query: options?.query === undefined ? null : { ...options.query },
      jsonBody: options?.jsonBody ?? null,
    });
    const key = `${method} ${apiPath}`;
    if (this.raiseOn.has(key)) {
      throw new GitHubError(
        `boom for ${apiPath}`,
        this.statusFor.get(apiPath) ?? 403,
      );
    }
    const next = this.responses.shift();
    if (next === undefined) {
      throw new Error("FakeTransport ran out of canned responses");
    }
    return next;
  }
}

function makeClient(): { client: GitHubClient; transport: FakeTransport } {
  const transport = new FakeTransport();
  return { client: new GitHubClient(transport), transport };
}

/** Listen on an ephemeral localhost port; returns the port. */
function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("unexpected server address"));
        return;
      }
      resolve(address.port);
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => {
      resolve();
    });
  });
}

describe("encodeRepo", () => {
  it("keeps a plain owner/name path", () => {
    expect(encodeRepo(REPO)).toBe(REPO);
  });

  it("percent-encodes unsafe characters", () => {
    expect(encodeRepo("my org/my repo")).toBe("my%20org/my%20repo");
  });

  it("trims surrounding whitespace", () => {
    expect(encodeRepo(`  ${REPO}  `)).toBe(REPO);
  });

  it.each(["", "just-a-name", "a/b/c", "/repo", "owner/"])(
    "rejects paths that are not owner/name (%s)",
    (bad) => {
      expect(() => encodeRepo(bad)).toThrow("owner/name");
    },
  );
});

describe("readFile", () => {
  it("resolves the default branch when ref is omitted", async () => {
    const { client, transport } = makeClient();
    transport.enqueue({ default_branch: "main" });
    transport.enqueue({
      type: "file",
      encoding: "base64",
      content: Buffer.from("hello world").toString("base64"),
      size: 11,
    });

    const file = await client.readFile(REPO, "readme.md");

    expect(file.content).toBe("hello world");
    expect(file.size).toBe(11);
    expect(file.type).toBe("file");
    expect(transport.requests[0]?.apiPath).toBe(`/repos/${REPO}`);
    expect(transport.requests[1]?.apiPath).toBe(
      `/repos/${REPO}/contents/readme.md`,
    );
    expect(transport.requests[1]?.query).toEqual({ ref: "main" });
  });

  it("with an explicit ref skips the repo lookup", async () => {
    const { client, transport } = makeClient();
    transport.enqueue({
      type: "file",
      encoding: "base64",
      content: Buffer.from("hi").toString("base64"),
      size: 2,
    });

    const file = await client.readFile(REPO, "readme.md", "dev/0.0.1");

    expect(file.content).toBe("hi");
    expect(transport.requests).toHaveLength(1);
    expect(transport.requests[0]?.query).toEqual({ ref: "dev/0.0.1" });
  });

  it("rejects paths that are not regular files", async () => {
    const { client, transport } = makeClient();
    transport.enqueue({ type: "dir" });

    await expect(client.readFile(REPO, "src", "main")).rejects.toThrow(
      "not a regular file",
    );
  });

  it("falls back to the blob API for large files", async () => {
    // The contents API inlines at most 1 MB; larger files arrive with an
    // empty body and must be fetched through the git blobs API.
    const { client, transport } = makeClient();
    transport.enqueue({
      type: "file",
      encoding: "base64",
      content: "",
      size: 2_000_000,
      sha: "blob-sha",
    });
    transport.enqueue({
      content: Buffer.from("big payload").toString("base64"),
      encoding: "base64",
      size: 2_000_000,
    });

    const file = await client.readFile(REPO, "large.bin", "main");

    expect(file.content).toBe("big payload");
    expect(file.size).toBe(2_000_000);
    expect(transport.requests[1]?.apiPath).toBe(
      `/repos/${REPO}/git/blobs/blob-sha`,
    );
  });

  it("keeps an empty file without a blob lookup", async () => {
    const { client, transport } = makeClient();
    transport.enqueue({
      type: "file",
      encoding: "base64",
      content: "",
      size: 0,
    });

    const file = await client.readFile(REPO, "empty.txt", "main");

    expect(file.content).toBe("");
    expect(transport.requests).toHaveLength(1);
  });
});

describe("listTree", () => {
  const treeResponse = (): Record<string, unknown> => ({
    sha: "t",
    truncated: false,
    tree: [
      { path: "src", type: "tree", sha: "s1", mode: "040000" },
      {
        path: "src/index.ts",
        type: "blob",
        sha: "s2",
        mode: "100644",
        size: 10,
      },
      {
        path: "src/util/helpers.ts",
        type: "blob",
        sha: "s3",
        mode: "100644",
        size: 5,
      },
      { path: "readme.md", type: "blob", sha: "s4", mode: "100644" },
    ],
  });

  it("returns the flattened tree at the root", async () => {
    const { client, transport } = makeClient();
    transport.enqueue({ default_branch: "main" });
    transport.enqueue(treeResponse());

    const entries = await client.listTree(REPO);

    expect(entries.map((entry) => entry.path)).toEqual([
      "src",
      "src/index.ts",
      "src/util/helpers.ts",
      "readme.md",
    ]);
    expect(transport.requests[1]?.apiPath).toBe(
      `/repos/${REPO}/git/trees/main`,
    );
    expect(transport.requests[1]?.query).toEqual({ recursive: "1" });
  });

  it("filters by path prefix", async () => {
    const { client, transport } = makeClient();
    transport.enqueue(treeResponse());

    const entries = await client.listTree(REPO, { path: "src", ref: "main" });

    // The prefix directory itself is excluded; only its subtree is listed.
    expect(entries.map((entry) => entry.path)).toEqual([
      "src/index.ts",
      "src/util/helpers.ts",
    ]);
  });

  it("names entries after their last path segment", async () => {
    const { client, transport } = makeClient();
    transport.enqueue(treeResponse());

    const entries = await client.listTree(REPO, {
      path: "src/util",
      ref: "main",
    });

    expect(entries.map((entry) => entry.name)).toEqual(["helpers.ts"]);
    expect(entries[0]?.size).toBe(5);
  });

  it("matches a single file path exactly", async () => {
    // A path pointing at one blob returns that file instead of an empty list.
    const { client, transport } = makeClient();
    transport.enqueue(treeResponse());

    const entries = await client.listTree(REPO, {
      path: "src/index.ts",
      ref: "main",
    });

    expect(entries.map((entry) => entry.path)).toEqual(["src/index.ts"]);
  });
});

describe("listCommits", () => {
  it("maps the nested commit shape", async () => {
    const { client, transport } = makeClient();
    transport.enqueue([
      {
        sha: "a".repeat(40),
        commit: {
          message: "feat: x\n\nbody",
          author: {
            name: "A",
            email: "a@example.com",
            date: "2026-09-18T10:00:00Z",
          },
        },
      },
    ]);

    const commits = await client.listCommits(REPO, { ref: "main", perPage: 5 });

    expect(commits).toHaveLength(1);
    const commit = commits[0];
    expect(commit?.id).toBe("a".repeat(40));
    expect(commit?.short_id).toBe("a".repeat(8));
    expect(commit?.title).toBe("feat: x");
    expect(commit?.author_name).toBe("A");
    expect(commit?.author_email).toBe("a@example.com");
    expect(commit?.authored_date).toBe("2026-09-18T10:00:00Z");
    expect(transport.requests[0]?.apiPath).toBe(`/repos/${REPO}/commits`);
    expect(transport.requests[0]?.query).toEqual({ sha: "main", per_page: 5 });
  });
});

describe("listBranches", () => {
  it("marks the default and protected flags", async () => {
    const { client, transport } = makeClient();
    transport.enqueue({ default_branch: "main" });
    transport.enqueue([
      { name: "main", protected: true },
      { name: "dev/0.0.1", protected: false },
    ]);

    const branches = await client.listBranches(REPO);

    expect(
      branches.map((branch) => [branch.name, branch.default, branch.protected]),
    ).toEqual([
      ["main", true, true],
      ["dev/0.0.1", false, false],
    ]);
    expect(transport.requests[1]?.apiPath).toBe(`/repos/${REPO}/branches`);
    expect(transport.requests[1]?.query).toEqual({ per_page: 50 });
  });
});

describe("createRepo", () => {
  const createdRepoPayload = (): Record<string, unknown> => ({
    id: 812345,
    name: "repo",
    full_name: "octocat/repo",
    private: true,
    default_branch: "main",
    html_url: "https://github.com/octocat/repo",
    clone_url: "https://github.com/octocat/repo.git",
    ssh_url: "git@github.com:octocat/repo.git",
  });

  it("posts to /user/repos without an owner", async () => {
    const { client, transport } = makeClient();
    transport.enqueue(createdRepoPayload());

    const repo = await client.createRepo({ name: "repo", private: true });

    expect(repo.full_name).toBe("octocat/repo");
    expect(transport.requests[0]?.method).toBe("POST");
    expect(transport.requests[0]?.apiPath).toBe("/user/repos");
    expect(transport.requests[0]?.jsonBody).toEqual({
      name: "repo",
      private: true,
    });
  });

  it("omits unset optional fields from the body", async () => {
    const { client, transport } = makeClient();
    transport.enqueue(createdRepoPayload());

    await client.createRepo({ name: "repo" });

    expect(transport.requests[0]?.jsonBody).toEqual({ name: "repo" });
  });

  it("uses /user/repos when the owner matches the login", async () => {
    const { client, transport } = makeClient();
    transport.enqueue({ login: "octocat" });
    transport.enqueue(createdRepoPayload());

    await client.createRepo({ name: "repo", owner: "Octocat" });

    expect(transport.requests[0]?.apiPath).toBe("/user");
    expect(transport.requests[1]?.apiPath).toBe("/user/repos");
  });

  it("uses the org endpoint for a different owner", async () => {
    const { client, transport } = makeClient();
    transport.enqueue({ login: "octocat" });
    transport.enqueue(createdRepoPayload());

    await client.createRepo({ name: "repo", owner: "my-org" });

    expect(transport.requests[1]?.apiPath).toBe("/orgs/my-org/repos");
  });

  it("falls back to the org endpoint when the user lookup fails", async () => {
    // Narrowly scoped tokens may not reach GET /user; the org endpoint is
    // then the only reasonable attempt.
    const { client, transport } = makeClient();
    transport.raiseOn.add("GET /user");
    transport.enqueue(createdRepoPayload());

    await client.createRepo({ name: "repo", owner: "my-org" });

    expect(transport.requests[0]?.apiPath).toBe("/user");
    expect(transport.requests[1]?.apiPath).toBe("/orgs/my-org/repos");
  });
});

describe("getRepo", () => {
  it("normalizes the repository object", async () => {
    const { client, transport } = makeClient();
    transport.enqueue({
      id: 42,
      name: "repo",
      full_name: "octocat/repo",
      description: "demo",
      private: false,
      default_branch: "main",
      html_url: "https://github.com/octocat/repo",
      language: "Python",
      stargazers_count: 7,
      forks_count: 2,
      open_issues_count: 3,
    });

    const info = await client.getRepo("octocat/repo");

    expect(info.full_name).toBe("octocat/repo");
    expect(info.language).toBe("Python");
    expect(info.stargazers_count).toBe(7);
    expect(transport.requests[0]?.apiPath).toBe("/repos/octocat/repo");
  });
});

describe("search", () => {
  it("searchCode maps items to repository and path", async () => {
    const { client, transport } = makeClient();
    transport.enqueue({
      total_count: 1,
      items: [
        {
          path: "src/index.ts",
          html_url: "https://github.com/octocat/repo/blob/main/src/index.ts",
          score: 1.0,
          repository: { full_name: "octocat/repo" },
        },
      ],
    });

    const hits = await client.searchCode("TODO repo:octocat/repo", {
      perPage: 5,
    });

    expect(hits.map((hit) => [hit.repository, hit.path])).toEqual([
      ["octocat/repo", "src/index.ts"],
    ]);
    expect(transport.requests[0]?.apiPath).toBe("/search/code");
    expect(transport.requests[0]?.query).toEqual({
      q: "TODO repo:octocat/repo",
      per_page: 5,
    });
  });

  it("searchRepositories skips items without id or full_name", async () => {
    const { client, transport } = makeClient();
    transport.enqueue({
      items: [
        {
          id: 1,
          full_name: "a/b",
          stargazers_count: 10,
          language: "Go",
        },
        { no_id: true },
      ],
    });

    const hits = await client.searchRepositories("query");

    expect(hits).toHaveLength(1);
    expect(hits[0]?.full_name).toBe("a/b");
    expect(transport.requests[0]?.apiPath).toBe("/search/repositories");
  });
});

describe("listTags", () => {
  it("maps name and commit sha", async () => {
    const { client, transport } = makeClient();
    transport.enqueue([{ name: "v1.0.0", commit: { sha: "c".repeat(40) } }]);

    const tags = await client.listTags(REPO);

    expect(tags.map((tag) => [tag.name, tag.commit_sha])).toEqual([
      ["v1.0.0", "c".repeat(40)],
    ]);
    expect(transport.requests[0]?.apiPath).toBe(`/repos/${REPO}/tags`);
    expect(transport.requests[0]?.query).toEqual({ per_page: 50 });
  });
});

describe("issues", () => {
  it("listIssues skips pull requests and maps labels", async () => {
    // The issues endpoint also returns pull requests; they carry a
    // `pull_request` key and must not show up as issues.
    const { client, transport } = makeClient();
    transport.enqueue([
      {
        number: 7,
        title: "bug",
        state: "open",
        user: { login: "octocat" },
        labels: [{ name: "bug" }, "urgent"],
        created_at: "2026-09-01T00:00:00Z",
        html_url: "https://github.com/o/r/issues/7",
      },
      {
        number: 8,
        title: "pr",
        state: "open",
        pull_request: { url: "https://api.github.com/o/r/pulls/8" },
      },
    ]);

    const issues = await client.listIssues(REPO, {
      state: "open",
      perPage: 10,
    });

    expect(issues).toHaveLength(1);
    expect(issues[0]?.number).toBe(7);
    expect(issues[0]?.labels).toEqual(["bug", "urgent"]);
    expect(issues[0]?.author).toBe("octocat");
    expect(transport.requests[0]?.apiPath).toBe(`/repos/${REPO}/issues`);
    expect(transport.requests[0]?.query).toEqual({
      state: "open",
      per_page: 10,
    });
  });

  it("createIssue posts the given fields only", async () => {
    const { client, transport } = makeClient();
    transport.enqueue({
      number: 9,
      title: "t",
      state: "open",
      html_url: "https://github.com/o/r/issues/9",
    });

    const issue = await client.createIssue(REPO, {
      title: "t",
      labels: ["bug"],
    });

    expect(issue.number).toBe(9);
    expect(transport.requests[0]?.method).toBe("POST");
    expect(transport.requests[0]?.apiPath).toBe(`/repos/${REPO}/issues`);
    expect(transport.requests[0]?.jsonBody).toEqual({
      title: "t",
      labels: ["bug"],
    });
  });
});

describe("pull requests", () => {
  it("listPullRequests maps head and base refs", async () => {
    const { client, transport } = makeClient();
    transport.enqueue([
      {
        number: 3,
        title: "feat",
        state: "open",
        draft: true,
        user: { login: "octocat" },
        head: { ref: "feature" },
        base: { ref: "main" },
      },
    ]);

    const pulls = await client.listPullRequests(REPO);

    expect(pulls[0]?.head_ref).toBe("feature");
    expect(pulls[0]?.base_ref).toBe("main");
    expect(pulls[0]?.draft).toBe(true);
    expect(transport.requests[0]?.apiPath).toBe(`/repos/${REPO}/pulls`);
    expect(transport.requests[0]?.query).toEqual({
      state: "open",
      per_page: 20,
    });
  });

  it("createPullRequest omits unset optional fields", async () => {
    const { client, transport } = makeClient();
    transport.enqueue({ number: 4, title: "feat", state: "open" });

    const pr = await client.createPullRequest(REPO, {
      title: "feat",
      head: "feature",
    });

    expect(pr.number).toBe(4);
    expect(transport.requests[0]?.jsonBody).toEqual({
      title: "feat",
      head: "feature",
    });
  });

  it("createPullRequest sends base, body and draft", async () => {
    const { client, transport } = makeClient();
    transport.enqueue({ number: 5, title: "feat", state: "open" });

    await client.createPullRequest(REPO, {
      title: "feat",
      head: "f",
      base: "main",
      body: "b",
      draft: true,
    });

    expect(transport.requests[0]?.jsonBody).toEqual({
      title: "feat",
      head: "f",
      base: "main",
      body: "b",
      draft: true,
    });
  });
});

describe("createBranch", () => {
  it.each(["feature-x", "dev/0.0.2", "v1.0.0", "fix_1"])(
    "accepts common branch names (%s)",
    (good) => {
      expect(validateBranchName(good)).toBe(good);
    },
  );

  it.each([
    "",
    "  ",
    "a b",
    "a..b",
    "-x",
    "x/",
    "a~b",
    "x@{y",
    "v1.lock",
    ".hidden",
  ])("rejects invalid branch names (%s)", (bad) => {
    expect(() => validateBranchName(bad)).toThrow(
      "not a valid git branch name",
    );
  });

  it("resolves the base ref to a sha", async () => {
    const { client, transport } = makeClient();
    transport.enqueue({ sha: "b".repeat(40) }); // GET /commits/{base}
    transport.enqueue({
      ref: "refs/heads/feature",
      object: { sha: "b".repeat(40) },
    });

    const created = await client.createBranch(REPO, {
      branch: "feature",
      fromRef: "release",
    });

    expect(created.ref).toBe("refs/heads/feature");
    expect(created.sha).toBe("b".repeat(40));
    expect(transport.requests[0]?.apiPath).toBe(
      `/repos/${REPO}/commits/release`,
    );
    expect(transport.requests[1]?.method).toBe("POST");
    expect(transport.requests[1]?.apiPath).toBe(`/repos/${REPO}/git/refs`);
    expect(transport.requests[1]?.jsonBody).toEqual({
      ref: "refs/heads/feature",
      sha: "b".repeat(40),
    });
  });

  it("defaults to the default branch", async () => {
    const { client, transport } = makeClient();
    transport.enqueue({ default_branch: "main" });
    transport.enqueue({ sha: "b".repeat(40) });
    transport.enqueue({ ref: "refs/heads/x", object: { sha: "b".repeat(40) } });

    await client.createBranch(REPO, { branch: "x" });

    expect(transport.requests[0]?.apiPath).toBe(`/repos/${REPO}`);
    expect(transport.requests[1]?.apiPath).toBe(`/repos/${REPO}/commits/main`);
  });

  it("rejects an invalid name before any request", async () => {
    const { client, transport } = makeClient();

    await expect(client.createBranch(REPO, { branch: "a b" })).rejects.toThrow(
      "not a valid git branch name",
    );
    expect(transport.requests).toEqual([]);
  });
});

describe("createOrUpdateFile", () => {
  it("creates a new file without a sha", async () => {
    const { client, transport } = makeClient();
    const contentsPath = `/repos/${REPO}/contents/docs/notes.md`;
    transport.raiseOn.add(`GET ${contentsPath}`);
    transport.statusFor.set(contentsPath, 404); // the file does not exist yet
    transport.enqueue({ default_branch: "main" });
    transport.enqueue({
      content: {
        sha: "newblob",
        html_url: `https://github.com/${REPO}/blob/main/docs/notes.md`,
      },
      commit: { sha: "c".repeat(40) },
    });

    const written = await client.createOrUpdateFile(REPO, {
      filePath: "docs/notes.md",
      content: "hello",
      message: "add notes",
    });

    expect(written.created).toBe(true);
    expect(written.blob_sha).toBe("newblob");
    const put = transport.requests.at(-1);
    expect(put?.method).toBe("PUT");
    expect(put?.apiPath).toBe(contentsPath);
    expect(put?.jsonBody).toEqual({
      message: "add notes",
      content: Buffer.from("hello").toString("base64"),
      branch: "main",
    });
  });

  it("sends the existing sha when updating", async () => {
    const { client, transport } = makeClient();
    transport.enqueue({ type: "file", sha: "oldblob" }); // GET contents
    transport.enqueue({ content: { sha: "newblob" } }); // PUT contents

    const written = await client.createOrUpdateFile(REPO, {
      filePath: "readme.md",
      content: "x",
      message: "m",
      branch: "dev",
    });

    expect(written.created).toBe(false);
    expect(transport.requests[0]?.apiPath).toBe(
      `/repos/${REPO}/contents/readme.md`,
    );
    expect(transport.requests[0]?.query).toEqual({ ref: "dev" });
    const put = transport.requests[1];
    expect(put?.method).toBe("PUT");
    expect(put?.jsonBody).toMatchObject({ sha: "oldblob", branch: "dev" });
    // An explicit branch skips the default-branch lookup entirely.
    expect(
      transport.requests.every(
        (request) => request.apiPath !== `/repos/${REPO}`,
      ),
    ).toBe(true);
  });

  it("rejects a directory path", async () => {
    const { client, transport } = makeClient();
    // The contents API answers with a list for directory paths.
    transport.enqueue([{ type: "file", path: "src/a.ts" }]);

    await expect(
      client.createOrUpdateFile(REPO, {
        filePath: "src",
        content: "x",
        message: "m",
        branch: "main",
      }),
    ).rejects.toThrow("exists as a directory");
  });

  it("propagates non-404 read errors", async () => {
    const { client, transport } = makeClient();
    transport.raiseOn.add(`GET /repos/${REPO}/contents/readme.md`); // 403
    transport.enqueue({ default_branch: "main" });

    await expect(
      client.createOrUpdateFile(REPO, {
        filePath: "readme.md",
        content: "x",
        message: "m",
      }),
    ).rejects.toThrow("boom");
  });
});

describe("HttpTransport", () => {
  isolateEnv([]);

  it("sends the bearer token and API version", async () => {
    const fetchStub = stubFetchRoutes([
      {
        method: "GET",
        url: `${DEFAULT_API_BASE_URL}/repos/${REPO}`,
        json: { default_branch: "main" },
      },
    ]);

    const transport = new HttpTransport("tok-secret");
    const data = await transport.request("GET", `/repos/${REPO}`);

    expect(data).toEqual({ default_branch: "main" });
    const request = fetchStub.lastCall();
    expect(request.headers["authorization"]).toBe("Bearer tok-secret");
    expect(request.headers["x-github-api-version"]).toBe("2022-11-28");
  });

  it("raises with the status on API errors", async () => {
    stubFetchRoutes([
      {
        method: "GET",
        url: `${DEFAULT_API_BASE_URL}/repos/${REPO}`,
        status: 404,
        json: { message: "Not Found" },
      },
    ]);

    const transport = new HttpTransport("tok-secret");
    const attempt = transport.request("GET", `/repos/${REPO}`);
    await expect(attempt).rejects.toThrow("404");
    await expect(attempt).rejects.toMatchObject({ status: 404 });
  });

  it("returns null for empty bodies", async () => {
    stubFetchRoutes([
      {
        method: "DELETE",
        url: `${DEFAULT_API_BASE_URL}/repos/${REPO}`,
        status: 204,
      },
    ]);

    const transport = new HttpTransport("tok-secret");
    expect(await transport.request("DELETE", `/repos/${REPO}`)).toBeNull();
  });

  it("honours a custom base URL", async () => {
    const fetchStub = stubFetchRoutes([
      {
        method: "GET",
        url: "https://ghe.example.com/api/v3/user",
        json: { login: "octocat" },
      },
    ]);

    const transport = new HttpTransport(
      "tok",
      "https://ghe.example.com/api/v3",
    );
    await transport.request("GET", "/user");

    expect(fetchStub.calls).toHaveLength(1);
  });

  it("follows redirects for renamed repositories", async () => {
    // Renamed/moved repositories answer 301 with the new API URL.
    const seenAuth: (string | undefined)[] = [];
    const server = createServer((req, res) => {
      seenAuth.push(req.headers["authorization"]);
      if (req.url === "/repos/old/name") {
        res.writeHead(301, { location: `/repos/${REPO}` });
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ default_branch: "main" }));
    });
    const port = await listen(server);
    try {
      const transport = new HttpTransport(
        "tok-secret",
        `http://127.0.0.1:${String(port)}`,
      );
      const data = await transport.request("GET", "/repos/old/name");

      expect(data).toEqual({ default_branch: "main" });
      // Both hops stay on the API origin, so both carry the token.
      expect(seenAuth).toEqual(["Bearer tok-secret", "Bearer tok-secret"]);
    } finally {
      await closeServer(server);
    }
  });

  it("drops the token on a cross-origin redirect", async () => {
    // Node's fetch strips the Authorization header when a redirect leaves
    // the origin, so a hostile Location cannot exfiltrate the token.
    let evilAuth: string | undefined = "not-checked";
    const evilServer = createServer((req, res) => {
      evilAuth = req.headers["authorization"];
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    const evilPort = await listen(evilServer);
    const apiServer = createServer((_req, res) => {
      res.writeHead(302, {
        location: `http://127.0.0.1:${String(evilPort)}/x`,
      });
      res.end();
    });
    const apiPort = await listen(apiServer);
    try {
      const transport = new HttpTransport(
        "tok-secret",
        `http://127.0.0.1:${String(apiPort)}`,
      );
      await transport.request("GET", "/repos/o/r");

      expect(evilAuth).toBeUndefined();
    } finally {
      await closeServer(apiServer);
      await closeServer(evilServer);
    }
  });

  it("requires a token", () => {
    expect(() => new HttpTransport("")).toThrow(GitHubError);
  });
});

describe("GhCliTransport", () => {
  isolateEnv(["PATH"]);

  it("parses JSON stdout", async () => {
    const dir = makeTempDir();
    writeFakeGh(dir, `printf '{"login": "octocat"}'`);
    process.env["PATH"] = dir;

    const data = await new GhCliTransport().request("GET", "/user");

    expect(data).toEqual({ login: "octocat" });
  });

  it("appends query params to the URL", async () => {
    // The fake gh echoes its last argument (the endpoint) back as JSON.
    const dir = makeTempDir();
    writeFakeGh(
      dir,
      `for last in "$@"; do :; done
printf '"%s"' "$last"`,
    );
    process.env["PATH"] = dir;

    const url = await new GhCliTransport().request(
      "GET",
      "/repos/o/r/commits",
      { query: { sha: "main", per_page: 5 } },
    );

    expect(url).toBe("/repos/o/r/commits?sha=main&per_page=5");
  });

  it("sends the JSON body through stdin", async () => {
    // The fake gh echoes stdin back, revealing exactly what arrived.
    // /bin/cat by absolute path: PATH only contains the fake gh's directory.
    const dir = makeTempDir();
    writeFakeGh(dir, "/bin/cat");
    process.env["PATH"] = dir;

    const result = await new GhCliTransport().request("POST", "/user/repos", {
      jsonBody: { name: "repo", private: true },
    });

    expect(result).toEqual({ name: "repo", private: true });
  });

  it("returns null for an empty body", async () => {
    const dir = makeTempDir();
    writeFakeGh(dir, "true");
    process.env["PATH"] = dir;

    expect(
      await new GhCliTransport().request("DELETE", "/repos/o/r"),
    ).toBeNull();
  });

  it("surfaces gh errors with the HTTP status", async () => {
    const dir = makeTempDir();
    writeFakeGh(
      dir,
      `echo "gh: HTTP 404: Not Found" >&2
exit 1`,
    );
    process.env["PATH"] = dir;

    const attempt = new GhCliTransport().request("GET", "/repos/o/r");
    await expect(attempt).rejects.toThrow("HTTP 404");
    await expect(attempt).rejects.toMatchObject({ status: 404 });
  });

  it("reports a missing executable", async () => {
    process.env["PATH"] = makeTempDir(); // no gh anywhere on PATH

    await expect(new GhCliTransport().request("GET", "/user")).rejects.toThrow(
      "Failed to run the gh CLI",
    );
  });
});

describe("ghCliIsAvailable / resolveTransport", () => {
  isolateEnv(["PATH"]);

  it("requires an executable on PATH", async () => {
    process.env["PATH"] = makeTempDir(); // empty dir: no gh

    expect(await ghCliIsAvailable()).toBe(false);
  });

  it("requires authentication", async () => {
    const dir = makeTempDir();
    writeFakeGh(dir, `if [ "$1" = "auth" ]; then exit 1; fi`);
    process.env["PATH"] = dir;

    expect(await ghCliIsAvailable()).toBe(false);
  });

  it("is true when installed and authenticated", async () => {
    const dir = makeTempDir();
    writeFakeGh(dir, `if [ "$1" = "auth" ]; then exit 0; fi`);
    process.env["PATH"] = dir;

    expect(await ghCliIsAvailable()).toBe(true);
  });

  it("resolveTransport prefers the gh CLI over a token", async () => {
    const dir = makeTempDir();
    writeFakeGh(dir, `if [ "$1" = "auth" ]; then exit 0; fi`);
    process.env["PATH"] = dir;

    const transport = await resolveTransport({ token: "tok" });

    expect(transport).toBeInstanceOf(GhCliTransport);
  });

  it("resolveTransport falls back to HTTP with a token", async () => {
    process.env["PATH"] = makeTempDir(); // no gh

    const transport = await resolveTransport({ token: "tok" });

    expect(transport).toBeInstanceOf(HttpTransport);
  });

  it("resolveTransport is null without gh or a token", async () => {
    process.env["PATH"] = makeTempDir(); // no gh

    expect(await resolveTransport()).toBeNull();
  });
});

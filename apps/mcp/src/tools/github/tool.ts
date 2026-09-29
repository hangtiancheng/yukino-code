// MCP tool registration for GitHub repositories.
//
// The tools prefer the local `gh` CLI when it is installed and authenticated
// and fall back to the token-based HTTP transport otherwise; the choice is
// made per call (see transport.ts).

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { loadConfig } from "../../shared/config.js";
import { logger } from "../../shared/logger.js";
import type { ToolModule } from "../types.js";
import {
  GitHubClient,
  type BranchEntry,
  type CodeSearchHit,
  type CommitEntry,
  type IssueEntry,
  type PullRequestEntry,
  type RepoInfo,
  type RepoSearchHit,
  type TagEntry,
  type TreeEntry,
} from "./client.js";
import { errorMessage, resolveTransport } from "./transport.js";

const REPO_DESCRIPTION =
  'Repository as `owner/name` (e.g. "hangtiancheng/yukino-code").';
const REF_DESCRIPTION =
  "Branch, tag or commit ref to read from. Defaults to the repository's default branch.";
const STATE_DESCRIPTION = 'Which entries to return: "open", "closed" or "all".';

const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

const WRITE_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
};

const IssueStateSchema = z.enum(["open", "closed", "all"]);

/**
 * Some MCP clients stringify JSON booleans on the wire ("false" instead of
 * false), which a strict z.boolean() rejects with a -32602 validation error.
 * Accept the exact string spellings as well and normalize to a real boolean;
 * any other string stays invalid.
 */
const LenientBooleanSchema = z
  .union([z.boolean(), z.enum(["true", "false"])])
  .transform((value): boolean => value === true || value === "true");

const ReadFileSchema = {
  repo: z.string().min(1).describe(REPO_DESCRIPTION),
  file_path: z
    .string()
    .min(1)
    .describe(
      'Path to the file within the repository, e.g. "src/index.ts" or "readme.md".',
    ),
  ref: z.string().nullish().describe(REF_DESCRIPTION),
};

const ListTreeSchema = {
  repo: z.string().min(1).describe(REPO_DESCRIPTION),
  path: z
    .string()
    .default("")
    .describe(
      "Directory path within the repository; empty string for the root.",
    ),
  ref: z.string().nullish().describe(REF_DESCRIPTION),
};

const ListCommitsSchema = {
  repo: z.string().min(1).describe(REPO_DESCRIPTION),
  ref: z.string().nullish().describe(REF_DESCRIPTION),
  per_page: z
    .number()
    .int()
    .min(1)
    .max(100)
    .default(20)
    .describe("Number of commits to return (1-100, default 20)."),
};

const ListBranchesSchema = {
  repo: z.string().min(1).describe(REPO_DESCRIPTION),
  per_page: z
    .number()
    .int()
    .min(1)
    .max(100)
    .default(50)
    .describe("Number of branches to return (1-100, default 50)."),
};

const CreateRepoSchema = {
  name: z.string().min(1).describe('Repository name, e.g. "my-new-repo".'),
  owner: z
    .string()
    .nullish()
    .describe(
      "Account or organization to create the repository under. Defaults to the authenticated user.",
    ),
  description: z
    .string()
    .nullish()
    .describe("Optional repository description."),
  private: LenientBooleanSchema.nullish().describe(
    "true for a private repository, false for public. Defaults to the account default.",
  ),
};

const GetRepoSchema = {
  repo: z.string().min(1).describe(REPO_DESCRIPTION),
};

const SearchCodeSchema = {
  query: z
    .string()
    .min(1)
    .describe(
      'GitHub code-search query, e.g. "TODO repo:owner/name" or ' +
        '"class MilvusClient language:python". Scope qualifiers (repo:, ' +
        "language:, path:, filename:) are part of the query string.",
    ),
  per_page: z
    .number()
    .int()
    .min(1)
    .max(100)
    .default(20)
    .describe("Number of matches to return (1-100, default 20)."),
};

const SearchRepositoriesSchema = {
  query: z
    .string()
    .min(1)
    .describe(
      'GitHub repository-search query, e.g. "milvus language:python stars:>1000".',
    ),
  per_page: z
    .number()
    .int()
    .min(1)
    .max(100)
    .default(20)
    .describe("Number of repositories to return (1-100, default 20)."),
};

const ListTagsSchema = {
  repo: z.string().min(1).describe(REPO_DESCRIPTION),
  per_page: z
    .number()
    .int()
    .min(1)
    .max(100)
    .default(50)
    .describe("Number of tags to return (1-100, default 50)."),
};

const ListIssuesSchema = {
  repo: z.string().min(1).describe(REPO_DESCRIPTION),
  state: IssueStateSchema.default("open").describe(STATE_DESCRIPTION),
  per_page: z
    .number()
    .int()
    .min(1)
    .max(100)
    .default(20)
    .describe("Number of issues to return (1-100, default 20)."),
};

const CreateIssueSchema = {
  repo: z.string().min(1).describe(REPO_DESCRIPTION),
  title: z.string().min(1).describe("Issue title."),
  body: z.string().nullish().describe("Optional issue body (markdown)."),
  labels: z
    .array(z.string())
    .nullish()
    .describe("Optional label names to attach."),
  assignees: z
    .array(z.string())
    .nullish()
    .describe("Optional user logins to assign."),
};

const ListPullRequestsSchema = {
  repo: z.string().min(1).describe(REPO_DESCRIPTION),
  state: IssueStateSchema.default("open").describe(STATE_DESCRIPTION),
  per_page: z
    .number()
    .int()
    .min(1)
    .max(100)
    .default(20)
    .describe("Number of pull requests to return (1-100, default 20)."),
};

const CreatePullRequestSchema = {
  repo: z.string().min(1).describe(REPO_DESCRIPTION),
  title: z.string().min(1).describe("Pull request title."),
  head: z
    .string()
    .min(1)
    .describe(
      'Branch containing the changes, e.g. "feature-x" (or "user:branch" for a cross-repository pull request).',
    ),
  base: z
    .string()
    .nullish()
    .describe(
      "Branch to merge into. Defaults to the repository's default branch.",
    ),
  body: z.string().nullish().describe("Optional pull request body (markdown)."),
  draft: LenientBooleanSchema.default(false).describe(
    "true to open the pull request as a draft.",
  ),
};

const CreateBranchSchema = {
  repo: z.string().min(1).describe(REPO_DESCRIPTION),
  branch: z.string().min(1).describe('New branch name, e.g. "feature-x".'),
  from_ref: z
    .string()
    .nullish()
    .describe(
      "Branch, tag or commit sha to branch from. Defaults to the repository's default branch.",
    ),
};

const CreateOrUpdateFileSchema = {
  repo: z.string().min(1).describe(REPO_DESCRIPTION),
  file_path: z
    .string()
    .min(1)
    .describe('Path of the file within the repository, e.g. "docs/notes.md".'),
  content: z.string().describe("Full new text content of the file (UTF-8)."),
  message: z.string().min(1).describe("Commit message for the change."),
  branch: z
    .string()
    .nullish()
    .describe(
      "Branch to write to. Defaults to the repository's default branch.",
    ),
};

function errorResult(err: unknown): {
  content: [{ type: "text"; text: string }];
  isError: true;
} {
  return {
    content: [{ type: "text", text: `✘ ${errorMessage(err)}` }],
    isError: true,
  };
}

/**
 * Name exactly what is missing, so the agent (or the person reading the tool
 * result) knows how to make the tools usable.
 */
function unavailable(): {
  content: [{ type: "text"; text: string }];
  isError: true;
} {
  return {
    content: [
      {
        type: "text",
        text:
          "✘ github tools are unavailable: no authenticated `gh` CLI was " +
          "found and no GITHUB_TOKEN is set. Authenticate the gh CLI " +
          "(`gh auth login`) or set the GITHUB_TOKEN env var (MCP client " +
          "env or .env) to a personal access token with repo access.",
      },
    ],
    isError: true,
  };
}

export function formatTree(entries: TreeEntry[]): string {
  if (entries.length === 0) {
    return "(empty)";
  }
  return entries
    .map((entry) => `${entry.type === "tree" ? "📁" : "📄"} ${entry.path}`)
    .join("\n");
}

export function formatCommits(entries: CommitEntry[]): string {
  if (entries.length === 0) {
    return "(no commits)";
  }
  return entries
    .map((commit) => {
      const date = (commit.authored_date ?? "").slice(0, 19).replace("T", " ");
      return `${commit.short_id}  ${date}  ${commit.author_name}  ${commit.title}`;
    })
    .join("\n");
}

export function formatBranches(entries: BranchEntry[]): string {
  if (entries.length === 0) {
    return "(no branches)";
  }
  return entries
    .map(
      (branch) =>
        `${branch.default ? "* " : "  "}${branch.name}${branch.protected === true ? " (protected)" : ""}`,
    )
    .join("\n");
}

export function formatRepo(info: RepoInfo): string {
  const lines = [`${info.full_name} (id ${String(info.id)})`];
  if (info.description) {
    lines.push(`description: ${info.description}`);
  }
  const visibility = info.private === true ? "private" : "public";
  const language = info.language ? `language: ${info.language}  ` : "";
  const stars =
    info.stargazers_count !== null
      ? `stars: ${String(info.stargazers_count)}  `
      : "";
  const forks =
    info.forks_count !== null ? `forks: ${String(info.forks_count)}  ` : "";
  const issues =
    info.open_issues_count !== null
      ? `open issues: ${String(info.open_issues_count)}`
      : "";
  lines.push(`${visibility}  ${language}${stars}${forks}${issues}`.trimEnd());
  if (info.default_branch) {
    lines.push(`default branch: ${info.default_branch}`);
  }
  if (info.created_at) {
    lines.push(`created: ${info.created_at.slice(0, 10)}`);
  }
  if (info.updated_at) {
    lines.push(`updated: ${info.updated_at.slice(0, 10)}`);
  }
  if (info.html_url) {
    lines.push(`web: ${info.html_url}`);
  }
  return lines.join("\n");
}

export function formatCodeHits(entries: CodeSearchHit[]): string {
  if (entries.length === 0) {
    return "(no matches)";
  }
  return entries.map((hit) => `${hit.repository}  ${hit.path}`).join("\n");
}

export function formatRepoHits(entries: RepoSearchHit[]): string {
  if (entries.length === 0) {
    return "(no matches)";
  }
  return entries
    .map((hit) => {
      const stars =
        hit.stargazers_count !== null
          ? `★${String(hit.stargazers_count)} `
          : "";
      const language = hit.language ? `[${hit.language}] ` : "";
      const description = hit.description ? `— ${hit.description}` : "";
      return `${hit.full_name} ${stars}${language}${description}`.trimEnd();
    })
    .join("\n");
}

export function formatTags(entries: TagEntry[]): string {
  if (entries.length === 0) {
    return "(no tags)";
  }
  return entries
    .map((tag) =>
      `${tag.name}  ${tag.commit_sha === null ? "" : tag.commit_sha.slice(0, 8)}`.trimEnd(),
    )
    .join("\n");
}

export function formatIssues(entries: IssueEntry[]): string {
  if (entries.length === 0) {
    return "(no issues)";
  }
  return entries
    .map((issue) => {
      const labels =
        issue.labels.length > 0 ? ` [${issue.labels.join(", ")}]` : "";
      const author = issue.author ? ` by ${issue.author}` : "";
      const date = issue.created_at
        ? ` on ${issue.created_at.slice(0, 10)}`
        : "";
      return `#${String(issue.number)} [${issue.state}] ${issue.title}${labels}${author}${date}`;
    })
    .join("\n");
}

export function formatPullRequests(entries: PullRequestEntry[]): string {
  if (entries.length === 0) {
    return "(no pull requests)";
  }
  return entries
    .map((pr) => {
      const state = `${pr.state}${pr.draft === true ? ", draft" : ""}`;
      const refs =
        pr.head_ref !== null && pr.base_ref !== null
          ? ` (${pr.head_ref} → ${pr.base_ref})`
          : "";
      const author = pr.author ? ` by ${pr.author}` : "";
      return `#${String(pr.number)} [${state}] ${pr.title}${refs}${author}`;
    })
    .join("\n");
}

/** The github_* tools, backed by the gh CLI or a GITHUB_TOKEN. */
export const githubModule: ToolModule = {
  name: "github",

  register(server: McpServer): void {
    /**
     * Resolve the transport per call from the environment.
     *
     * Per-call (rather than captured at registration) so configuration set
     * after the server instance was built is picked up, and tests can stub
     * the env freely.
     */
    async function makeClient(): Promise<GitHubClient | null> {
      const { github } = loadConfig();
      const transport = await resolveTransport({
        token: github.token,
        baseUrl: github.baseUrl,
      });
      return transport === null ? null : new GitHubClient(transport);
    }

    server.registerTool(
      "github_read_file",
      {
        title: "GitHub Read File",
        description:
          "Read a single file's text content from a GitHub repository at a " +
          "given ref. Returns the raw file content.",
        inputSchema: ReadFileSchema,
        annotations: READ_ONLY_ANNOTATIONS,
      },
      async ({ repo, file_path, ref }) => {
        const client = await makeClient();
        if (client === null) {
          return unavailable();
        }
        try {
          const file = await client.readFile(repo, file_path, ref);
          logger.info({ repo, file_path, ref }, "github_read_file ok");
          return {
            content: [{ type: "text", text: file.content }],
            structuredContent: {
              repo,
              file_path,
              ref: ref ?? null,
              size: file.size,
              type: file.type,
            },
          };
        } catch (err) {
          logger.warn({ err }, "github_read_file failed");
          return errorResult(err);
        }
      },
    );

    server.registerTool(
      "github_list_tree",
      {
        title: "GitHub List Tree",
        description:
          "List the files and directories at a path in a GitHub repository " +
          "(recursive, flattened). Useful for exploring a repo's structure.",
        inputSchema: ListTreeSchema,
        annotations: READ_ONLY_ANNOTATIONS,
      },
      async ({ repo, path, ref }) => {
        const client = await makeClient();
        if (client === null) {
          return unavailable();
        }
        try {
          const entries = await client.listTree(repo, { path, ref });
          logger.info(
            { repo, path, ref, count: entries.length },
            "github_list_tree ok",
          );
          return {
            content: [{ type: "text", text: formatTree(entries) }],
            structuredContent: {
              repo,
              path,
              ref: ref ?? null,
              count: entries.length,
            },
          };
        } catch (err) {
          logger.warn({ err }, "github_list_tree failed");
          return errorResult(err);
        }
      },
    );

    server.registerTool(
      "github_list_commits",
      {
        title: "GitHub List Commits",
        description:
          "List recent commits on a ref in a GitHub repository. Returns " +
          "commit id, date, author and title.",
        inputSchema: ListCommitsSchema,
        annotations: READ_ONLY_ANNOTATIONS,
      },
      async ({ repo, ref, per_page }) => {
        const client = await makeClient();
        if (client === null) {
          return unavailable();
        }
        try {
          const commits = await client.listCommits(repo, {
            ref,
            perPage: per_page,
          });
          logger.info(
            { repo, ref, count: commits.length },
            "github_list_commits ok",
          );
          return {
            content: [{ type: "text", text: formatCommits(commits) }],
            structuredContent: {
              repo,
              ref: ref ?? null,
              count: commits.length,
            },
          };
        } catch (err) {
          logger.warn({ err }, "github_list_commits failed");
          return errorResult(err);
        }
      },
    );

    server.registerTool(
      "github_list_branches",
      {
        title: "GitHub List Branches",
        description:
          "List branches of a GitHub repository. Marks the default and " +
          "protected branches.",
        inputSchema: ListBranchesSchema,
        annotations: READ_ONLY_ANNOTATIONS,
      },
      async ({ repo, per_page }) => {
        const client = await makeClient();
        if (client === null) {
          return unavailable();
        }
        try {
          const branches = await client.listBranches(repo, {
            perPage: per_page,
          });
          logger.info(
            { repo, count: branches.length },
            "github_list_branches ok",
          );
          return {
            content: [{ type: "text", text: formatBranches(branches) }],
            structuredContent: { repo, count: branches.length },
          };
        } catch (err) {
          logger.warn({ err }, "github_list_branches failed");
          return errorResult(err);
        }
      },
    );

    server.registerTool(
      "github_create_repo",
      {
        title: "GitHub Create Repo",
        description:
          "Create a new repository on GitHub, under the authenticated user " +
          "or an organization. Returns the new repository's id, full name " +
          "and clone URLs.",
        inputSchema: CreateRepoSchema,
        annotations: WRITE_ANNOTATIONS,
      },
      async ({ name, owner, description, private: isPrivate }) => {
        const client = await makeClient();
        if (client === null) {
          return unavailable();
        }
        try {
          const repo = await client.createRepo({
            name,
            owner,
            description,
            private: isPrivate,
          });
          logger.info(
            { repo: repo.full_name, id: repo.id },
            "github_create_repo ok",
          );
          const lines = [`Created ${repo.full_name} (id ${String(repo.id)})`];
          if (repo.html_url) {
            lines.push(`web:  ${repo.html_url}`);
          }
          if (repo.clone_url) {
            lines.push(`http: ${repo.clone_url}`);
          }
          if (repo.ssh_url) {
            lines.push(`ssh:  ${repo.ssh_url}`);
          }
          return {
            content: [{ type: "text", text: lines.join("\n") }],
            structuredContent: {
              id: repo.id,
              name: repo.name,
              full_name: repo.full_name,
              html_url: repo.html_url,
              clone_url: repo.clone_url,
              ssh_url: repo.ssh_url,
            },
          };
        } catch (err) {
          logger.warn({ err }, "github_create_repo failed");
          return errorResult(err);
        }
      },
    );

    server.registerTool(
      "github_get_repo",
      {
        title: "GitHub Get Repo",
        description:
          "Get a GitHub repository's metadata: description, visibility, " +
          "language, star/fork/open-issue counts, default branch and URLs.",
        inputSchema: GetRepoSchema,
        annotations: READ_ONLY_ANNOTATIONS,
      },
      async ({ repo }) => {
        const client = await makeClient();
        if (client === null) {
          return unavailable();
        }
        try {
          const info = await client.getRepo(repo);
          logger.info({ repo: info.full_name }, "github_get_repo ok");
          return {
            content: [{ type: "text", text: formatRepo(info) }],
            structuredContent: {
              id: info.id,
              full_name: info.full_name,
              private: info.private,
              default_branch: info.default_branch,
              language: info.language,
              stargazers_count: info.stargazers_count,
              forks_count: info.forks_count,
              open_issues_count: info.open_issues_count,
              html_url: info.html_url,
            },
          };
        } catch (err) {
          logger.warn({ err }, "github_get_repo failed");
          return errorResult(err);
        }
      },
    );

    server.registerTool(
      "github_search_code",
      {
        title: "GitHub Search Code",
        description:
          "Search file contents across GitHub with the code-search query " +
          'syntax (e.g. "TODO repo:owner/name", "class Foo language:python"). ' +
          "Returns the matching repository and file path for each hit.",
        inputSchema: SearchCodeSchema,
        annotations: READ_ONLY_ANNOTATIONS,
      },
      async ({ query, per_page }) => {
        const client = await makeClient();
        if (client === null) {
          return unavailable();
        }
        try {
          const hits = await client.searchCode(query, { perPage: per_page });
          logger.info({ query, count: hits.length }, "github_search_code ok");
          return {
            content: [{ type: "text", text: formatCodeHits(hits) }],
            structuredContent: { query, count: hits.length },
          };
        } catch (err) {
          logger.warn({ err }, "github_search_code failed");
          return errorResult(err);
        }
      },
    );

    server.registerTool(
      "github_search_repositories",
      {
        title: "GitHub Search Repositories",
        description:
          "Search GitHub repositories by name, description, language, stars " +
          'and other qualifiers (e.g. "milvus language:python stars:>1000").',
        inputSchema: SearchRepositoriesSchema,
        annotations: READ_ONLY_ANNOTATIONS,
      },
      async ({ query, per_page }) => {
        const client = await makeClient();
        if (client === null) {
          return unavailable();
        }
        try {
          const hits = await client.searchRepositories(query, {
            perPage: per_page,
          });
          logger.info(
            { query, count: hits.length },
            "github_search_repositories ok",
          );
          return {
            content: [{ type: "text", text: formatRepoHits(hits) }],
            structuredContent: { query, count: hits.length },
          };
        } catch (err) {
          logger.warn({ err }, "github_search_repositories failed");
          return errorResult(err);
        }
      },
    );

    server.registerTool(
      "github_list_tags",
      {
        title: "GitHub List Tags",
        description:
          "List tags of a GitHub repository with the commit sha each tag " +
          "points at.",
        inputSchema: ListTagsSchema,
        annotations: READ_ONLY_ANNOTATIONS,
      },
      async ({ repo, per_page }) => {
        const client = await makeClient();
        if (client === null) {
          return unavailable();
        }
        try {
          const tags = await client.listTags(repo, { perPage: per_page });
          logger.info({ repo, count: tags.length }, "github_list_tags ok");
          return {
            content: [{ type: "text", text: formatTags(tags) }],
            structuredContent: { repo, count: tags.length },
          };
        } catch (err) {
          logger.warn({ err }, "github_list_tags failed");
          return errorResult(err);
        }
      },
    );

    server.registerTool(
      "github_list_issues",
      {
        title: "GitHub List Issues",
        description:
          "List issues of a GitHub repository (pull requests are excluded). " +
          "Returns number, state, title, labels, author and date.",
        inputSchema: ListIssuesSchema,
        annotations: READ_ONLY_ANNOTATIONS,
      },
      async ({ repo, state, per_page }) => {
        const client = await makeClient();
        if (client === null) {
          return unavailable();
        }
        try {
          const issues = await client.listIssues(repo, {
            state,
            perPage: per_page,
          });
          logger.info(
            { repo, state, count: issues.length },
            "github_list_issues ok",
          );
          return {
            content: [{ type: "text", text: formatIssues(issues) }],
            structuredContent: { repo, state, count: issues.length },
          };
        } catch (err) {
          logger.warn({ err }, "github_list_issues failed");
          return errorResult(err);
        }
      },
    );

    server.registerTool(
      "github_create_issue",
      {
        title: "GitHub Create Issue",
        description:
          "Create a new issue in a GitHub repository, optionally with a " +
          "markdown body, labels and assignees. Returns the issue number " +
          "and URL.",
        inputSchema: CreateIssueSchema,
        annotations: WRITE_ANNOTATIONS,
      },
      async ({ repo, title, body, labels, assignees }) => {
        const client = await makeClient();
        if (client === null) {
          return unavailable();
        }
        try {
          const issue = await client.createIssue(repo, {
            title,
            body,
            labels,
            assignees,
          });
          logger.info({ repo, number: issue.number }, "github_create_issue ok");
          const lines = [
            `Created issue #${String(issue.number)}: ${issue.title}`,
          ];
          if (issue.html_url) {
            lines.push(`web: ${issue.html_url}`);
          }
          return {
            content: [{ type: "text", text: lines.join("\n") }],
            structuredContent: {
              repo,
              number: issue.number,
              title: issue.title,
              state: issue.state,
              html_url: issue.html_url,
            },
          };
        } catch (err) {
          logger.warn({ err }, "github_create_issue failed");
          return errorResult(err);
        }
      },
    );

    server.registerTool(
      "github_list_pull_requests",
      {
        title: "GitHub List Pull Requests",
        description:
          "List pull requests of a GitHub repository. Returns number, " +
          "state (with draft flag), title, head/base refs and author.",
        inputSchema: ListPullRequestsSchema,
        annotations: READ_ONLY_ANNOTATIONS,
      },
      async ({ repo, state, per_page }) => {
        const client = await makeClient();
        if (client === null) {
          return unavailable();
        }
        try {
          const pulls = await client.listPullRequests(repo, {
            state,
            perPage: per_page,
          });
          logger.info(
            { repo, state, count: pulls.length },
            "github_list_pull_requests ok",
          );
          return {
            content: [{ type: "text", text: formatPullRequests(pulls) }],
            structuredContent: { repo, state, count: pulls.length },
          };
        } catch (err) {
          logger.warn({ err }, "github_list_pull_requests failed");
          return errorResult(err);
        }
      },
    );

    server.registerTool(
      "github_create_pull_request",
      {
        title: "GitHub Create Pull Request",
        description:
          "Open a pull request in a GitHub repository from a head branch " +
          "into a base branch (the default branch when base is omitted). " +
          "Returns the pull request number and URL.",
        inputSchema: CreatePullRequestSchema,
        annotations: WRITE_ANNOTATIONS,
      },
      async ({ repo, title, head, base, body, draft }) => {
        const client = await makeClient();
        if (client === null) {
          return unavailable();
        }
        try {
          const pr = await client.createPullRequest(repo, {
            title,
            head,
            base,
            body,
            draft,
          });
          logger.info(
            { repo, number: pr.number },
            "github_create_pull_request ok",
          );
          const lines = [
            `Created pull request #${String(pr.number)}: ${pr.title}`,
          ];
          if (pr.html_url) {
            lines.push(`web: ${pr.html_url}`);
          }
          return {
            content: [{ type: "text", text: lines.join("\n") }],
            structuredContent: {
              repo,
              number: pr.number,
              title: pr.title,
              state: pr.state,
              html_url: pr.html_url,
            },
          };
        } catch (err) {
          logger.warn({ err }, "github_create_pull_request failed");
          return errorResult(err);
        }
      },
    );

    server.registerTool(
      "github_create_branch",
      {
        title: "GitHub Create Branch",
        description:
          "Create a new branch in a GitHub repository, pointing at another " +
          "branch, tag or commit sha (the default branch when omitted). " +
          "Returns the created ref and commit sha.",
        inputSchema: CreateBranchSchema,
        annotations: WRITE_ANNOTATIONS,
      },
      async ({ repo, branch, from_ref }) => {
        const client = await makeClient();
        if (client === null) {
          return unavailable();
        }
        try {
          const created = await client.createBranch(repo, {
            branch,
            fromRef: from_ref,
          });
          logger.info({ repo, ref: created.ref }, "github_create_branch ok");
          return {
            content: [
              {
                type: "text",
                text: `Created ${created.ref} at ${created.sha.slice(0, 8)}`,
              },
            ],
            structuredContent: { repo, ref: created.ref, sha: created.sha },
          };
        } catch (err) {
          logger.warn({ err }, "github_create_branch failed");
          return errorResult(err);
        }
      },
    );

    server.registerTool(
      "github_create_or_update_file",
      {
        title: "GitHub Create or Update File",
        description:
          "Write one file's full text content to a branch of a GitHub " +
          "repository in a single commit: creates the file when it does " +
          "not exist and overwrites it when it does. Returns the blob sha " +
          "and whether the file was created or updated.",
        inputSchema: CreateOrUpdateFileSchema,
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: true,
        },
      },
      async ({ repo, file_path, content, message, branch }) => {
        const client = await makeClient();
        if (client === null) {
          return unavailable();
        }
        try {
          const written = await client.createOrUpdateFile(repo, {
            filePath: file_path,
            content,
            message,
            branch,
          });
          logger.info(
            { repo, file_path: written.path, created: written.created },
            "github_create_or_update_file ok",
          );
          const verb = written.created ? "Created" : "Updated";
          const lines = [`${verb} ${written.path} in ${repo}`];
          if (written.html_url) {
            lines.push(`web: ${written.html_url}`);
          }
          return {
            content: [{ type: "text", text: lines.join("\n") }],
            structuredContent: {
              repo,
              path: written.path,
              blob_sha: written.blob_sha,
              html_url: written.html_url,
              created: written.created,
            },
          };
        } catch (err) {
          logger.warn({ err }, "github_create_or_update_file failed");
          return errorResult(err);
        }
      },
    );
  },
};

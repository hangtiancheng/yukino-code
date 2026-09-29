// Minimal GitHub client over a pluggable transport.
//
// The client knows the REST endpoints and response shapes; how a request
// physically reaches GitHub (an authenticated `gh` CLI subprocess or a bearer
// token HTTP call) is decided by the transport it is constructed with — see
// transport.ts. Responses are normalized into the types below so the tool
// layer never sees raw API payloads.
//
// Field names stay snake_case on purpose: these shapes flow straight into the
// tools' structuredContent, whose wire names match the GitHub API.

import { z } from "zod";

import { logger } from "../../shared/logger.js";
import {
  GitHubError,
  errorMessage,
  type GitHubTransport,
} from "./transport.js";

/**
 * Validate an `owner/name` repository path and URL-encode it for API paths.
 *
 * Throws GitHubError for anything that is not exactly `owner/name`, so a
 * malformed argument fails before it is interpolated into a URL.
 */
export function encodeRepo(repo: string): string {
  const parts = repo.trim().split("/");
  if (parts.length !== 2 || parts[0] === "" || parts[1] === "") {
    throw new GitHubError(
      'Repository must be an `owner/name` path (e.g. "hangtiancheng/yukino-agent2"), ' +
        `got "${repo}".`,
    );
  }
  return `${encodeURIComponent(parts[0])}/${encodeURIComponent(parts[1])}`;
}

/** Percent-encode a repository file path, keeping `/` separators intact. */
export function encodePath(filePath: string): string {
  return filePath
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

/** Strip leading and trailing slashes (Python's `str.strip("/")`). */
function stripSlashes(value: string): string {
  return value.replace(/^\/+/, "").replace(/\/+$/, "");
}

/** Characters git forbids anywhere in a ref name. */
const INVALID_REF_CHARS = /[\p{White_Space}~^:?*[\\\u0000-\u001F]/u;

/**
 * Validate a new branch name against git's ref rules (the common subset).
 *
 * Throws GitHubError early so a malformed name never reaches the API.
 */
export function validateBranchName(branch: string): string {
  const name = branch.trim();
  const invalid =
    name === "" ||
    name.startsWith("/") ||
    name.startsWith("-") ||
    name.startsWith(".") ||
    name.endsWith("/") ||
    name.endsWith(".") ||
    name.endsWith(".lock") ||
    name.includes("..") ||
    name.includes("@{") ||
    INVALID_REF_CHARS.test(name);
  if (invalid) {
    throw new GitHubError(`"${branch}" is not a valid git branch name.`);
  }
  return name;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asInt(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

function asBool(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asRecordArray(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is Record<string, unknown> =>
    isRecord(entry),
  );
}

export interface TreeEntry {
  id: string;
  name: string;
  /** "blob" for files, "tree" for directories (git tree terminology). */
  type: string;
  path: string;
  mode: string | null;
  size: number | null;
}

export interface CommitEntry {
  id: string;
  short_id: string;
  title: string;
  author_name: string;
  author_email: string | null;
  authored_date: string | null;
}

export interface BranchEntry {
  name: string;
  default: boolean;
  protected: boolean | null;
}

export interface FileContent {
  content: string;
  size: number | null;
  type: string | null;
}

export interface CodeSearchHit {
  /** `owner/name` of the repository the match lives in. */
  repository: string;
  path: string;
  html_url: string | null;
  score: number | null;
}

export interface TagEntry {
  name: string;
  commit_sha: string | null;
}

export interface IssueEntry {
  number: number;
  title: string;
  state: string;
  author: string | null;
  labels: string[];
  html_url: string | null;
  created_at: string | null;
}

export interface PullRequestEntry {
  number: number;
  title: string;
  state: string;
  draft: boolean | null;
  author: string | null;
  head_ref: string | null;
  base_ref: string | null;
  html_url: string | null;
  created_at: string | null;
}

export interface CreatedBranch {
  /** The created git ref, e.g. `refs/heads/feature-x`. */
  ref: string;
  /** Commit sha the new branch points at. */
  sha: string;
}

export interface WrittenFile {
  path: string;
  /** Blob sha of the written content. */
  blob_sha: string | null;
  html_url: string | null;
  /** True when the file did not exist before, false when it was overwritten. */
  created: boolean;
}

// Payloads validated as a whole mirror the Python original's pydantic models
// (extra keys ignored — zod objects strip unknown keys by default).

const CreatedRepoSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  full_name: z.string(),
  description: z.string().nullable().default(null),
  private: z.boolean().nullable().default(null),
  default_branch: z.string().nullable().default(null),
  html_url: z.string().nullable().default(null),
  clone_url: z.string().nullable().default(null),
  ssh_url: z.string().nullable().default(null),
});
export type CreatedRepo = z.infer<typeof CreatedRepoSchema>;

const RepoInfoSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  full_name: z.string(),
  description: z.string().nullable().default(null),
  private: z.boolean().nullable().default(null),
  default_branch: z.string().nullable().default(null),
  html_url: z.string().nullable().default(null),
  language: z.string().nullable().default(null),
  stargazers_count: z.number().int().nullable().default(null),
  forks_count: z.number().int().nullable().default(null),
  open_issues_count: z.number().int().nullable().default(null),
  created_at: z.string().nullable().default(null),
  updated_at: z.string().nullable().default(null),
});
export type RepoInfo = z.infer<typeof RepoInfoSchema>;

const RepoSearchHitSchema = z.object({
  id: z.number().int(),
  full_name: z.string(),
  description: z.string().nullable().default(null),
  private: z.boolean().nullable().default(null),
  html_url: z.string().nullable().default(null),
  language: z.string().nullable().default(null),
  stargazers_count: z.number().int().nullable().default(null),
  updated_at: z.string().nullable().default(null),
});
export type RepoSearchHit = z.infer<typeof RepoSearchHitSchema>;

const CreatedIssueSchema = z.object({
  number: z.number().int(),
  title: z.string(),
  state: z.string().nullable().default(null),
  html_url: z.string().nullable().default(null),
});
export type CreatedIssue = z.infer<typeof CreatedIssueSchema>;

const CreatedPullRequestSchema = z.object({
  number: z.number().int(),
  title: z.string(),
  state: z.string().nullable().default(null),
  html_url: z.string().nullable().default(null),
});
export type CreatedPullRequest = z.infer<typeof CreatedPullRequestSchema>;

function decodeBase64Utf8(value: string): string {
  return Buffer.from(value, "base64").toString("utf-8");
}

/** The github_* operations, transport-agnostic. */
export class GitHubClient {
  private readonly transport: GitHubTransport;

  constructor(transport: GitHubTransport) {
    this.transport = transport;
  }

  /** The repository's default branch (GitHub always reports one). */
  async getDefaultBranch(repo: string): Promise<string> {
    const data = await this.transport.request(
      "GET",
      `/repos/${encodeRepo(repo)}`,
    );
    const branch = isRecord(data) ? asString(data["default_branch"]) : null;
    if (branch === null || branch === "") {
      throw new GitHubError(
        `GitHub did not report a default branch for ${repo}.`,
      );
    }
    return branch;
  }

  /**
   * An explicit ref passes through; nullish resolves to the default branch
   * (GitHub repos are split between `main` and `master`, so guessing is not
   * an option).
   */
  private async resolveRef(repo: string, ref?: string | null): Promise<string> {
    return ref !== undefined && ref !== null && ref !== ""
      ? ref
      : await this.getDefaultBranch(repo);
  }

  /** Read a file's text content at a ref via the contents API. */
  async readFile(
    repo: string,
    filePath: string,
    ref?: string | null,
  ): Promise<FileContent> {
    const resolvedRef = await this.resolveRef(repo, ref);
    const data = await this.transport.request(
      "GET",
      `/repos/${encodeRepo(repo)}/contents/${encodePath(stripSlashes(filePath))}`,
      { query: { ref: resolvedRef } },
    );
    if (!isRecord(data)) {
      throw new GitHubError(
        `GitHub returned no file metadata for ${filePath}.`,
      );
    }

    const entryType = asString(data["type"]);
    if (entryType !== "file") {
      throw new GitHubError(
        `"${filePath}" is not a regular file (type: ${entryType ?? "unknown"}).`,
      );
    }
    const rawContent = asString(data["content"]);
    if (rawContent === null) {
      throw new GitHubError(
        `GitHub returned no readable content for ${filePath}.`,
      );
    }
    const size = asInt(data["size"]);
    if (rawContent === "" && size !== null && size !== 0) {
      // The contents API inlines at most 1 MB; larger files come back with an
      // empty body and must be fetched through the git blobs API.
      const blobSha = asString(data["sha"]);
      if (blobSha === null || blobSha === "") {
        throw new GitHubError(
          `GitHub returned no content for ${filePath} and no blob to fetch.`,
        );
      }
      const blob = await this.transport.request(
        "GET",
        `/repos/${encodeRepo(repo)}/git/blobs/${encodeURIComponent(blobSha)}`,
      );
      const blobContent = isRecord(blob) ? asString(blob["content"]) : null;
      if (blobContent === null) {
        throw new GitHubError(
          `GitHub returned no blob content for ${filePath}.`,
        );
      }
      const blobSize = isRecord(blob) ? asInt(blob["size"]) : null;
      return {
        content: decodeBase64Utf8(blobContent),
        size: blobSize ?? size,
        type: entryType,
      };
    }
    const text =
      asString(data["encoding"]) === "base64"
        ? decodeBase64Utf8(rawContent)
        : rawContent;
    return { content: text, size, type: entryType };
  }

  /**
   * List the repository tree at a path/ref (recursive, flattened).
   *
   * Uses the git trees API with `recursive=1` and filters by path prefix
   * locally, so one call gives the agent the whole subtree.
   */
  async listTree(
    repo: string,
    options: {
      path?: string | undefined;
      ref?: string | null | undefined;
    } = {},
  ): Promise<TreeEntry[]> {
    const resolvedRef = await this.resolveRef(repo, options.ref);
    const data = await this.transport.request(
      "GET",
      `/repos/${encodeRepo(repo)}/git/trees/${encodeURIComponent(resolvedRef)}`,
      { query: { recursive: "1" } },
    );
    if (!isRecord(data) || !Array.isArray(data["tree"])) {
      throw new GitHubError(
        `GitHub returned no tree for ${repo} at ${resolvedRef}.`,
      );
    }
    if (data["truncated"] === true) {
      logger.warn(
        { repo, path: options.path ?? "", ref: resolvedRef },
        "github tree truncated",
      );
    }

    const prefix = stripSlashes(options.path ?? "");
    const entries: TreeEntry[] = [];
    for (const raw of asRecordArray(data["tree"])) {
      const entryPath = asString(raw["path"]);
      const sha = asString(raw["sha"]);
      const entryType = asString(raw["type"]);
      if (entryPath === null || sha === null || entryType === null) {
        continue;
      }
      if (prefix !== "") {
        // Subtree entries pass the prefix filter; a prefix pointing at a
        // single file matches that blob exactly (the directory entry itself
        // stays excluded, so `path="src"` lists src's children).
        if (
          !entryPath.startsWith(`${prefix}/`) &&
          !(entryPath === prefix && entryType === "blob")
        ) {
          continue;
        }
      }
      entries.push({
        id: sha,
        name: entryPath.slice(entryPath.lastIndexOf("/") + 1),
        type: entryType,
        path: entryPath,
        mode: asString(raw["mode"]),
        size: asInt(raw["size"]),
      });
    }
    return entries;
  }

  /** List commits on a ref. */
  async listCommits(
    repo: string,
    options: {
      ref?: string | null | undefined;
      perPage?: number | undefined;
    } = {},
  ): Promise<CommitEntry[]> {
    const resolvedRef = await this.resolveRef(repo, options.ref);
    const data = await this.transport.request(
      "GET",
      `/repos/${encodeRepo(repo)}/commits`,
      { query: { sha: resolvedRef, per_page: options.perPage ?? 20 } },
    );
    if (!Array.isArray(data)) {
      throw new GitHubError(`GitHub returned no commit list for ${repo}.`);
    }

    const entries: CommitEntry[] = [];
    for (const raw of asRecordArray(data)) {
      const sha = asString(raw["sha"]);
      if (sha === null) {
        continue;
      }
      const commit = isRecord(raw["commit"]) ? raw["commit"] : {};
      const author = isRecord(commit["author"]) ? commit["author"] : {};
      const message = asString(commit["message"]) ?? "";
      entries.push({
        id: sha,
        short_id: sha.slice(0, 8),
        title: message.split("\n")[0],
        author_name: asString(author["name"]) ?? "",
        author_email: asString(author["email"]),
        authored_date: asString(author["date"]),
      });
    }
    return entries;
  }

  /**
   * List branches; the default one is marked via the repository object (the
   * branches endpoint itself does not say which one is default).
   */
  async listBranches(
    repo: string,
    options: { perPage?: number | undefined } = {},
  ): Promise<BranchEntry[]> {
    const defaultBranch = await this.getDefaultBranch(repo);
    const data = await this.transport.request(
      "GET",
      `/repos/${encodeRepo(repo)}/branches`,
      { query: { per_page: options.perPage ?? 50 } },
    );
    if (!Array.isArray(data)) {
      throw new GitHubError(`GitHub returned no branch list for ${repo}.`);
    }

    const entries: BranchEntry[] = [];
    for (const raw of asRecordArray(data)) {
      const name = asString(raw["name"]);
      if (name === null || name === "") {
        continue;
      }
      entries.push({
        name,
        default: name === defaultBranch,
        protected: asBool(raw["protected"]),
      });
    }
    return entries;
  }

  /**
   * Create a repository under the authenticated user or an organization.
   *
   * GitHub has two creation endpoints: POST /user/repos (the authenticated
   * user) and POST /orgs/{org}/repos (an organization). When `owner` is given
   * it is compared against the authenticated login to pick the right one; if
   * the login cannot be determined the org endpoint is attempted.
   */
  async createRepo(options: {
    name: string;
    owner?: string | null | undefined;
    description?: string | null | undefined;
    private?: boolean | null | undefined;
  }): Promise<CreatedRepo> {
    let endpoint = "/user/repos";
    const owner = options.owner?.trim() ?? "";
    if (owner !== "") {
      const login = await this.authenticatedLogin();
      if (login?.toLowerCase() !== owner.toLowerCase()) {
        endpoint = `/orgs/${encodeURIComponent(owner)}/repos`;
      }
    }

    const body: Record<string, unknown> = { name: options.name };
    if (options.description !== undefined && options.description !== null) {
      body["description"] = options.description;
    }
    if (options.private !== undefined && options.private !== null) {
      body["private"] = options.private;
    }
    const data = await this.transport.request("POST", endpoint, {
      jsonBody: body,
    });
    return CreatedRepoSchema.parse(data);
  }

  /** Repository metadata: visibility, language, counters, URLs. */
  async getRepo(repo: string): Promise<RepoInfo> {
    const data = await this.transport.request(
      "GET",
      `/repos/${encodeRepo(repo)}`,
    );
    if (!isRecord(data)) {
      throw new GitHubError(
        `GitHub returned no repository metadata for ${repo}.`,
      );
    }
    return RepoInfoSchema.parse(data);
  }

  /**
   * Search file contents across GitHub.
   *
   * `query` is GitHub's code-search syntax (e.g. `TODO repo:owner/name`);
   * scoping to one repository is part of the query string.
   */
  async searchCode(
    query: string,
    options: { perPage?: number | undefined } = {},
  ): Promise<CodeSearchHit[]> {
    const data = await this.transport.request("GET", "/search/code", {
      query: { q: query, per_page: options.perPage ?? 20 },
    });
    if (!isRecord(data) || !Array.isArray(data["items"])) {
      throw new GitHubError(
        `GitHub returned no code search results for "${query}".`,
      );
    }

    const entries: CodeSearchHit[] = [];
    for (const raw of asRecordArray(data["items"])) {
      const path = asString(raw["path"]);
      if (path === null) {
        continue;
      }
      const repository = isRecord(raw["repository"])
        ? asString(raw["repository"]["full_name"])
        : null;
      entries.push({
        repository: repository ?? "",
        path,
        html_url: asString(raw["html_url"]),
        score: asNumber(raw["score"]),
      });
    }
    return entries;
  }

  /** Search repositories across GitHub (e.g. `milvus language:python`). */
  async searchRepositories(
    query: string,
    options: { perPage?: number | undefined } = {},
  ): Promise<RepoSearchHit[]> {
    const data = await this.transport.request("GET", "/search/repositories", {
      query: { q: query, per_page: options.perPage ?? 20 },
    });
    if (!isRecord(data) || !Array.isArray(data["items"])) {
      throw new GitHubError(
        `GitHub returned no repository search results for "${query}".`,
      );
    }

    const entries: RepoSearchHit[] = [];
    for (const raw of asRecordArray(data["items"])) {
      if (asString(raw["full_name"]) === null || asInt(raw["id"]) === null) {
        continue;
      }
      entries.push(RepoSearchHitSchema.parse(raw));
    }
    return entries;
  }

  /** List tags (name + the commit sha each one points at). */
  async listTags(
    repo: string,
    options: { perPage?: number | undefined } = {},
  ): Promise<TagEntry[]> {
    const data = await this.transport.request(
      "GET",
      `/repos/${encodeRepo(repo)}/tags`,
      { query: { per_page: options.perPage ?? 50 } },
    );
    if (!Array.isArray(data)) {
      throw new GitHubError(`GitHub returned no tag list for ${repo}.`);
    }

    const entries: TagEntry[] = [];
    for (const raw of asRecordArray(data)) {
      const name = asString(raw["name"]);
      if (name === null || name === "") {
        continue;
      }
      entries.push({
        name,
        commit_sha: isRecord(raw["commit"])
          ? asString(raw["commit"]["sha"])
          : null,
      });
    }
    return entries;
  }

  /**
   * List issues. The issues endpoint also returns pull requests, so entries
   * carrying a `pull_request` key are skipped.
   */
  async listIssues(
    repo: string,
    options: { state?: string | undefined; perPage?: number | undefined } = {},
  ): Promise<IssueEntry[]> {
    const data = await this.transport.request(
      "GET",
      `/repos/${encodeRepo(repo)}/issues`,
      {
        query: {
          state: options.state ?? "open",
          per_page: options.perPage ?? 20,
        },
      },
    );
    if (!Array.isArray(data)) {
      throw new GitHubError(`GitHub returned no issue list for ${repo}.`);
    }

    const entries: IssueEntry[] = [];
    for (const raw of asRecordArray(data)) {
      if ("pull_request" in raw) {
        continue;
      }
      const number = asInt(raw["number"]);
      if (number === null) {
        continue;
      }
      const labels: string[] = [];
      if (Array.isArray(raw["labels"])) {
        for (const label of raw["labels"]) {
          if (typeof label === "string") {
            labels.push(label);
          } else if (isRecord(label)) {
            const name = asString(label["name"]);
            if (name !== null) {
              labels.push(name);
            }
          }
        }
      }
      entries.push({
        number,
        title: asString(raw["title"]) ?? "",
        state: asString(raw["state"]) ?? "open",
        author: isRecord(raw["user"]) ? asString(raw["user"]["login"]) : null,
        labels,
        html_url: asString(raw["html_url"]),
        created_at: asString(raw["created_at"]),
      });
    }
    return entries;
  }

  /** Open a new issue. */
  async createIssue(
    repo: string,
    options: {
      title: string;
      body?: string | null | undefined;
      labels?: string[] | null | undefined;
      assignees?: string[] | null | undefined;
    },
  ): Promise<CreatedIssue> {
    const payload: Record<string, unknown> = { title: options.title };
    if (options.body !== undefined && options.body !== null) {
      payload["body"] = options.body;
    }
    if (
      options.labels !== undefined &&
      options.labels !== null &&
      options.labels.length > 0
    ) {
      payload["labels"] = options.labels;
    }
    if (
      options.assignees !== undefined &&
      options.assignees !== null &&
      options.assignees.length > 0
    ) {
      payload["assignees"] = options.assignees;
    }
    const data = await this.transport.request(
      "POST",
      `/repos/${encodeRepo(repo)}/issues`,
      { jsonBody: payload },
    );
    if (!isRecord(data)) {
      throw new GitHubError(`GitHub returned no created issue for ${repo}.`);
    }
    return CreatedIssueSchema.parse(data);
  }

  /** List pull requests. */
  async listPullRequests(
    repo: string,
    options: { state?: string | undefined; perPage?: number | undefined } = {},
  ): Promise<PullRequestEntry[]> {
    const data = await this.transport.request(
      "GET",
      `/repos/${encodeRepo(repo)}/pulls`,
      {
        query: {
          state: options.state ?? "open",
          per_page: options.perPage ?? 20,
        },
      },
    );
    if (!Array.isArray(data)) {
      throw new GitHubError(
        `GitHub returned no pull request list for ${repo}.`,
      );
    }

    const entries: PullRequestEntry[] = [];
    for (const raw of asRecordArray(data)) {
      const number = asInt(raw["number"]);
      if (number === null) {
        continue;
      }
      entries.push({
        number,
        title: asString(raw["title"]) ?? "",
        state: asString(raw["state"]) ?? "open",
        draft: asBool(raw["draft"]),
        author: isRecord(raw["user"]) ? asString(raw["user"]["login"]) : null,
        head_ref: isRecord(raw["head"]) ? asString(raw["head"]["ref"]) : null,
        base_ref: isRecord(raw["base"]) ? asString(raw["base"]["ref"]) : null,
        html_url: asString(raw["html_url"]),
        created_at: asString(raw["created_at"]),
      });
    }
    return entries;
  }

  /**
   * Open a pull request from `head` into `base` (default branch when `base`
   * is omitted).
   */
  async createPullRequest(
    repo: string,
    options: {
      title: string;
      head: string;
      base?: string | null | undefined;
      body?: string | null | undefined;
      draft?: boolean | undefined;
    },
  ): Promise<CreatedPullRequest> {
    const payload: Record<string, unknown> = {
      title: options.title,
      head: options.head,
    };
    const base = options.base ?? "";
    if (base !== "") {
      payload["base"] = base;
    }
    if (options.body !== undefined && options.body !== null) {
      payload["body"] = options.body;
    }
    if (options.draft === true) {
      payload["draft"] = true;
    }
    const data = await this.transport.request(
      "POST",
      `/repos/${encodeRepo(repo)}/pulls`,
      { jsonBody: payload },
    );
    if (!isRecord(data)) {
      throw new GitHubError(
        `GitHub returned no created pull request for ${repo}.`,
      );
    }
    return CreatedPullRequestSchema.parse(data);
  }

  /**
   * Create a branch from another ref (branch, tag or sha; the repository's
   * default branch when omitted).
   */
  async createBranch(
    repo: string,
    options: { branch: string; fromRef?: string | null | undefined },
  ): Promise<CreatedBranch> {
    const name = validateBranchName(options.branch);
    const base = options.fromRef?.trim() ?? "";
    const resolvedBase = base !== "" ? base : await this.getDefaultBranch(repo);
    // Resolve the base ref to a commit sha; one endpoint covers branches,
    // tags and shas alike.
    const commit = await this.transport.request(
      "GET",
      `/repos/${encodeRepo(repo)}/commits/${encodeURIComponent(resolvedBase)}`,
    );
    const sha = isRecord(commit) ? asString(commit["sha"]) : null;
    if (sha === null || sha === "") {
      throw new GitHubError(
        `GitHub could not resolve ref "${resolvedBase}" in ${repo}.`,
      );
    }
    const ref = `refs/heads/${name}`;
    const data = await this.transport.request(
      "POST",
      `/repos/${encodeRepo(repo)}/git/refs`,
      { jsonBody: { ref, sha } },
    );
    if (!isRecord(data)) {
      throw new GitHubError(`GitHub returned no created ref for ${ref}.`);
    }
    const objectSha = isRecord(data["object"])
      ? asString(data["object"]["sha"])
      : null;
    return {
      ref: asString(data["ref"]) ?? ref,
      sha: objectSha ?? sha,
    };
  }

  /**
   * Write one file on a branch via the contents API (create or overwrite).
   *
   * Updates require the current blob sha, so an existing file is read first;
   * a 404 there means the file is created.
   */
  async createOrUpdateFile(
    repo: string,
    options: {
      filePath: string;
      content: string;
      message: string;
      branch?: string | null | undefined;
    },
  ): Promise<WrittenFile> {
    const path = stripSlashes(options.filePath);
    if (path === "") {
      throw new GitHubError("file_path must not be empty.");
    }
    const branch = options.branch?.trim() ?? "";
    const resolvedBranch =
      branch !== "" ? branch : await this.getDefaultBranch(repo);
    const contentsPath = `/repos/${encodeRepo(repo)}/contents/${encodePath(path)}`;

    let existingSha: string | null = null;
    try {
      const existing = await this.transport.request("GET", contentsPath, {
        query: { ref: resolvedBranch },
      });
      if (
        Array.isArray(existing) ||
        (isRecord(existing) && existing["type"] === "dir")
      ) {
        throw new GitHubError(
          `"${options.filePath}" exists as a directory in ${repo}; ` +
            "cannot write a file there.",
        );
      }
      if (isRecord(existing)) {
        const sha = asString(existing["sha"]);
        if (sha !== null && sha !== "") {
          existingSha = sha;
        }
      }
    } catch (err) {
      if (!(err instanceof GitHubError) || err.status !== 404) {
        throw err;
      }
      // 404: the file does not exist yet — create it below.
    }

    const payload: Record<string, unknown> = {
      message: options.message,
      content: Buffer.from(options.content, "utf-8").toString("base64"),
      branch: resolvedBranch,
    };
    if (existingSha !== null) {
      payload["sha"] = existingSha;
    }
    const data = await this.transport.request("PUT", contentsPath, {
      jsonBody: payload,
    });
    if (!isRecord(data)) {
      throw new GitHubError(
        `GitHub returned no write result for ${options.filePath}.`,
      );
    }
    const written = isRecord(data["content"]) ? data["content"] : null;
    return {
      path,
      blob_sha: written === null ? null : asString(written["sha"]),
      html_url: written === null ? null : asString(written["html_url"]),
      created: existingSha === null,
    };
  }

  /**
   * The authenticated user's login, or null when /user is not accessible
   * with the current credentials (e.g. a narrowly scoped token).
   */
  private async authenticatedLogin(): Promise<string | null> {
    let data: unknown;
    try {
      data = await this.transport.request("GET", "/user");
    } catch (err) {
      logger.debug(
        { err: errorMessage(err) },
        "github /user lookup failed; falling back to the org endpoint",
      );
      return null;
    }
    const login = isRecord(data) ? asString(data["login"]) : null;
    return login !== null && login !== "" ? login : null;
  }
}

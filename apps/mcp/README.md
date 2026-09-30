# @yukino.js/mcp

The **Yukino MCP server** — an official collection of MCP tools for the
[Yukino CLI](../../README.md). It ships four tool groups today: a semantic
`docs` RAG tool over your local Yukino knowledge base, a `create_app`
tool that lets agents deliver interactive MCP Apps with a sandboxed UI,
a `chrome` tool group that drives the user's browser through the Yukino
Chrome extension, and a `github` tool group that exposes GitHub
repositories (files, trees, commits, branches, tags, issues, pull
requests) to agents.

[![npm](https://img.shields.io/npm/v/@yukino.js/mcp?label=npm&color=F05138)](https://www.npmjs.com/package/@yukino.js/mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-f5a623.svg)](../../LICENSE)

## Tools

### `docs`

Semantic (embedding-based) RAG search over the local Yukino knowledge base,
built from the Markdown/text documents in `YUKINO_DOCS_DIR` (default
`~/.yukino/docs`). Embeddings are stored in a Redis index and retrieved with
similarity scoring.

- **Input** — `query` (natural language), `top_k` (1–10, default 3).
- **Output** — the most relevant document chunks with source file, section title,
  and similarity score.
- **Degraded mode** — if Redis or the embedding provider is unavailable, the tool
  returns an honest error rather than failing silently.

### `create_app`

Delivers an interactive MCP App: the agent provides an HTML
string and a title, and the tool renders it in a sandboxed iframe (no storage or
cookies; external assets restricted to popular CDNs). Hosts without MCP Apps
support fall back to a text note.

### `chrome` (browser automation)

Drives the user's Chrome through the Yukino browser extension. The MCP server
talks to the extension's native messaging host over a local Unix socket
(per-user socket directory, permission- and ownership-validated) and exposes
the extension's tools: tab discovery (`tabs_context_mcp`, `tabs_create_mcp`),
page inspection (`read_page`, `find`, `get_page_text`, `read_console_messages`,
`read_network_requests`), interaction (`computer`, `javascript_tool`,
`form_input`, `navigate`, `upload_image`, `resize_window`), plus `gif_creator`,
`shortcuts_*` and `update_plan`.

- **Multi-profile** — when several Chrome profiles expose sockets, a pool
  connects to all of them and routes calls by `tabId` (call `tabs_context_mcp`
  first to build the routing table).
- **Degraded mode** — without the extension installed/running, calls return a
  setup hint instead of failing silently.

### `github` (repository access)

Access to GitHub repositories. The repo-scoped tools take a `repo` argument —
an `owner/name` path (e.g. `hangtiancheng/yukino-code`) — and the search
tools take a GitHub query string.

| Tool                           | Kind  | Purpose                                                        |
| ------------------------------ | ----- | -------------------------------------------------------------- |
| `github_read_file`             | read  | Read a file's text content at a ref                            |
| `github_list_tree`             | read  | List files/directories at a path (recursive, flattened)        |
| `github_list_commits`          | read  | List recent commits on a ref                                   |
| `github_list_branches`         | read  | List branches (marks default / protected)                      |
| `github_list_tags`             | read  | List tags with the commit sha each one points at               |
| `github_get_repo`              | read  | Repository metadata: visibility, language, stars/forks, URLs   |
| `github_search_code`           | read  | Search file contents (GitHub code-search query syntax)         |
| `github_search_repositories`   | read  | Search repositories (name, language, stars, ...)               |
| `github_list_issues`           | read  | List issues (pull requests excluded), with labels and authors  |
| `github_list_pull_requests`    | read  | List pull requests with head/base refs and draft flag          |
| `github_create_repo`           | write | Create a repository under the user or an organization          |
| `github_create_issue`          | write | Open an issue (optional body, labels, assignees)               |
| `github_create_pull_request`   | write | Open a pull request from a head branch (optionally as a draft) |
| `github_create_branch`         | write | Create a branch from another branch, tag or sha                |
| `github_create_or_update_file` | write | Write one file's content to a branch in a single commit        |

**Backend selection** — each call picks a transport in this order:

1. **`gh` CLI** — when the `gh` executable is on PATH and `gh auth status`
   reports an authenticated login. Calls run through `gh api`, reusing the
   machine's existing GitHub credentials; no token passes through this
   process.
2. **HTTP + token** — otherwise, when `GITHUB_TOKEN` (or `GH_TOKEN`) is set:
   direct REST calls to `GITHUB_BASE_URL` (default `https://api.github.com`)
   with the token as a bearer token.
3. **Unavailable** — with neither, each `github_*` call answers with a clear
   error naming both options; the server always starts either way.

## Configuration

| Environment variable | Description                                                                   | Default                  |
| -------------------- | ----------------------------------------------------------------------------- | ------------------------ |
| `EMBEDDING_PROTOCOL` | Embedding provider protocol (`openai` is the only supported value)            | `openai`                 |
| `EMBEDDING_MODEL`    | Embedding model id (e.g. `text-embedding-v4`)                                 | —                        |
| `EMBEDDING_BASE_URL` | OpenAI-compatible `embeddings` endpoint base URL                              | —                        |
| `EMBEDDING_API_KEY`  | API key (falls back to `OPENAI_API_KEY`)                                      | —                        |
| `REDIS_URL`          | Redis connection string                                                       | `redis://localhost:6379` |
| `REDIS_INDEX_NAME`   | Redis index name                                                              | `idx:yukino`             |
| `REDIS_KEY_PREFIX`   | Redis key prefix                                                              | `yukino:`                |
| `YUKINO_DOCS_DIR`    | Local docs directory to index                                                 | `~/.yukino/docs`         |
| `GITHUB_TOKEN`       | Personal access token for the `github_*` HTTP fallback; secret — never logged | —                        |
| `GH_TOKEN`           | Fallback for `GITHUB_TOKEN` (the variable the `gh` CLI uses)                  | —                        |
| `GITHUB_BASE_URL`    | REST API base URL for the HTTP fallback (GitHub Enterprise API URL)           | `https://api.github.com` |
| `HOST`               | HTTP transport bind address                                                   | `127.0.0.1`              |
| `PORT`               | HTTP transport port                                                           | `3300`                   |

Both **stdio** (default) and **HTTP** transports are supported: `--http` (or
`MCP_TRANSPORT=http`) starts `startHttpServer`, which serves the same tools over
streamable HTTP (`POST /mcp`) and legacy SSE (`GET /sse` + `POST /messages`).
The HTTP endpoints are **unauthenticated**; keep `HOST` bound to localhost (the
default) and only enable HTTP on a trusted machine — with the `chrome` tools
registered, anyone who can reach the port can drive the browser.

## Getting started

Run from the repository root:

```sh
pnpm install
cp apps/mcp/.env.example apps/mcp/.env   # configure embedding + Redis
pnpm --filter @yukino.js/mcp dev         # build UI + run over stdio
```

| Command                              | Description               |
| ------------------------------------ | ------------------------- |
| `pnpm --filter @yukino.js/mcp dev`   | Build UI + run over stdio |
| `pnpm --filter @yukino.js/mcp build` | Bundle (tsup) + build UI  |
| `pnpm --filter @yukino.js/mcp test`  | Build UI + vitest         |
| `pnpm build` (root)                  | Build every workspace app |

## Layout

```
mcp/
├── src/
│   ├── main.ts         # stdio/HTTP entrypoint + shutdown
│   ├── server.ts       # MCP server + tool registration
│   ├── http.ts         # h3 app: streamable HTTP + legacy SSE transports
│   ├── version.ts      # package version (build-time define, package.json fallback)
│   ├── shared/         # config (zod) + logger
│   └── tools/
│       ├── index.ts    # the tool modules hosted by this server
│       ├── types.ts    # ToolModule interface
│       ├── docs/       # RAG pipeline (chunk/embed/index/retrieve)
│       ├── create-app/ # MCP App create tool + UI shell
│       ├── chrome/     # browser automation via the Chrome extension socket
│       └── github/     # gh-CLI/HTTP transports + GitHubClient + the github_* tools
└── tests/
```

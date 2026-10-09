# @yukino.js/mcp

The **Yukino MCP server** — an official collection of MCP tools for the
[Yukino CLI](../../README.md). It includes a semantic
`docs_tool` RAG tool over your local Yukino knowledge base, a `create_app`
tool that lets agents deliver interactive MCP Apps with a sandboxed UI,
and a `github_tool` that runs GitHub CLI commands, plus PostgreSQL, MySQL, Redis, MongoDB and Prometheus tools.

[![npm](https://img.shields.io/npm/v/@yukino.js/mcp?label=npm&color=F05138)](https://www.npmjs.com/package/@yukino.js/mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-f5a623.svg)](../../LICENSE)

## Tools

All public tool names are explicitly maintained in `src/tools/names.ts`.
Names use snake_case with at least two words. Existing compound names such as
`create_app` and `docs_sync` remain unchanged; single-word names use `_tool`,
including `docs_tool` and `github_tool`.

### `docs_tool`

Semantic (embedding-based) RAG search over the local Yukino knowledge base,
built from the Markdown/text documents in `YUKINO_DOCS_DIR` (default
`~/.yukino/docs`). Embeddings are stored in a local SQLite index
(`YUKINO_INDEX_DB`, default `~/.yukino/index.sqlite`) and retrieved with cosine
similarity scoring — no external service is required.

- **Input** — `query` (natural language), `top_k` (1–10, default 3).
- **Output** — the most relevant document chunks with source file, section title,
  and similarity score, also returned as structured documents.
- **Degraded mode** — if the index or the embedding provider is unavailable, the
  tool returns an honest error rather than failing silently.

`docs_sync` takes no arguments and waits for indexing to finish. Use it after
editing the knowledge base. Changes replace chunks and content hashes atomically;
embedding or file-read failures preserve the last indexed version. An initial
search against an empty index reports when indexing is still in progress.

### `create_app`

Delivers an interactive MCP App: the agent provides an HTML
string and a title, and the tool renders it in a sandboxed iframe (no storage or
cookies; external assets restricted to popular CDNs). Hosts without MCP Apps
support fall back to a text note.

### `github_tool`

Run any GitHub CLI (`gh`) command through one tool: repositories, issues, PRs,
reviews/merges, Actions, releases/assets, projects, REST and GraphQL. The former
`github_*` wrappers are replaced by this single entry point.

- **Input** — `args` (argument array without the leading `gh`), optional `cwd`,
  `stdin`, `timeout_ms` (default `60000`) and `response_format` (`text` or `base64`).
- **Execution** — arguments are passed directly to `gh` without shell parsing or
  a command allowlist. `cwd` selects a local repository; `stdin` supports JSON
  payloads with `gh api --input -`, issue/PR bodies with `--body-file -`, etc.
  Interactive prompts and pagers are disabled. Timeout or MCP cancellation
  terminates the process (and its child process group on POSIX).
- **Output** — `stdout`, `stderr`, `exit_code`, `signal`, `timed_out` and
  `cancelled`. Nonzero exits, signals, timeouts and cancellation set
  `isError: true` while retaining partial output. Use `response_format: "base64"`
  for binary stdout such as API archive downloads.
- **Setup** — install `gh` on PATH and authenticate with `gh auth login`, or set
  `GH_TOKEN`/`GITHUB_TOKEN`. Native gh environment settings are preserved,
  including `GH_HOST` and `GH_ENTERPRISE_TOKEN`/`GITHUB_ENTERPRISE_TOKEN`.
  Legacy `GITHUB_BASE_URL` supplies its hostname when `GH_HOST` is unset.
  Missing CLI/authentication is reported per call and never prevents startup.

Use `--help` to discover subcommands, `--json`/`--jq` to focus results, and
`gh api --paginate --slurp` or GraphQL cursors to control pagination.

```json
{"tool":"github_tool","arguments":{"args":["pr","list","--repo","owner/repo","--json","number,title,state"]}}
{"tool":"github_tool","arguments":{"args":["pr","merge","3","--repo","owner/repo","--squash"]}}
{"tool":"github_tool","arguments":{"args":["api","repos/owner/repo/issues/7","--method","PATCH","--input","-"],"stdin":"{\"state\":\"closed\",\"labels\":[]}"}}
{"tool":"github_tool","arguments":{"args":["api","graphql","-f","query=query { viewer { login } }"]}}
{"tool":"github_tool","arguments":{"args":["api","repos/owner/repo/issues","--paginate","--slurp"]}}
{"tool":"github_tool","arguments":{"args":["api","repos/owner/repo/actions/artifacts/123/zip"],"response_format":"base64"}}
```

### `postgres_tool` / `mysql_tool`

Execute SQL verbatim with the connection account's full privileges, including
SELECT, INSERT, UPDATE, DELETE, DDL, administration and multiple statements.
There is no SQL allowlist, read-only mode or confirmation step.

- **Input** — `sql`, optional `params` (default `[]`), optional `connection_url`.
- **Connections** — PostgreSQL uses `POSTGRES_URL`, falling back to
  `POSTGRESQL_URL` then `DATABASE_URL`; MySQL uses `MYSQL_URL`.
  `connection_url` overrides the configured target for that call.
- **Parameters** — PostgreSQL uses `$1`, `$2`, etc.; MySQL uses `?`.
  PostgreSQL multi-statement calls require an empty `params` array.
- **Output** — PostgreSQL returns `results` with each statement's `command`,
  `row_count`, `rows` and `fields`. MySQL returns driver `results` and `fields`,
  including mutation headers (`affectedRows`, `insertId`) and multiple row sets.
  Large integer values remain strings rather than losing precision.

Each call uses a dedicated connection and closes it after success or failure.
Put a complete transaction or session-dependent statement sequence in one call;
session state does not persist between calls. Unconfigured backends report the
missing environment variable when called and do not prevent server startup.

```json
{"tool":"postgres_tool","arguments":{"sql":"UPDATE jobs SET state = $1 WHERE id = $2 RETURNING *","params":["done",7]}}
{"tool":"mysql_tool","arguments":{"connection_url":"mysql://user:password@localhost:3306/demo","sql":"START TRANSACTION; CREATE TABLE example(id INT); INSERT INTO example VALUES (1); SELECT * FROM example; COMMIT;"}}
```

### `redis_tool`

Execute arbitrary Redis commands, including writes, Lua scripts, configuration,
ACLs and destructive commands. Uses `REDIS_URL` (default
`redis://localhost:6379`) or a per-call `connection_url`. This tool uses its own
connection and is independent of the docs index, which is SQLite-backed and needs
no Redis at all.

Supply `commands` as an array of argument arrays. Arguments are sent verbatim;
there is no shell parsing, key prefix or command allowlist. Commands run in
order on one dedicated connection, so `SELECT` and `MULTI`/`EXEC` work within a
call. The connection is closed afterward. Responses appear in `results` in the
same order. A command failure stops the batch and returns `isError: true`,
completed replies and the zero-based `failed_command_index`; earlier commands
may already have executed.

```json
{"tool":"redis_tool","arguments":{"commands":[["SET","example","hello world"],["GET","example"],["DEL","example"]]}}
{"tool":"redis_tool","arguments":{"commands":[["SELECT","2"],["MULTI"],["INCR","counter"],["EXPIRE","counter","60"],["EXEC"]]}}
```

### `mongodb_tool`

Run a raw MongoDB `command` document with full connection privileges. Supports
find, insert, update, delete, aggregate, indexes, collection/database deletion,
users and administrative commands without an operation allowlist. Set
`database: "admin"` for server-level operations.

Uses `MONGODB_URL` or `connection_url`. `database` overrides `MONGODB_DATABASE`;
otherwise the driver uses the database from the URL. Each call opens and closes
its own client. Inputs accept Extended JSON BSON values, such as
`{"$oid":"507f1f77bcf86cd799439011"}`. The complete command response is returned
under `data` as canonical Extended JSON, preserving ObjectIds, timestamps,
64-bit integers and cursor batches. Control find results with MongoDB command
fields such as `filter`, `projection`, `sort`, `skip`, `limit` and `batchSize`.

```json
{"tool":"mongodb_tool","arguments":{"database":"demo","command":{"find":"users","filter":{"active":true},"limit":10,"batchSize":10}}}
{"tool":"mongodb_tool","arguments":{"database":"demo","command":{"update":"users","updates":[{"q":{"_id":{"$oid":"507f1f77bcf86cd799439011"}},"u":{"$set":{"active":false}},"multi":false}]}}}
```

### `prometheus_tool`

Call any Prometheus HTTP endpoint. `path` defaults to `/api/v1/alerts`, returning
every alert instance with its labels and annotations. Use `/api/v1/query` or
`/api/v1/query_range` for PromQL; targets, rules, labels, series and metadata
endpoints for inspection; and admin/TSDB or management endpoints for mutations.
There is no endpoint allowlist or read-only restriction; server-side feature
flags and account privileges still determine available operations.

- **Input** — optional `base_url`, `path`, `method` (default `GET`), `params`,
  `body`, `headers`, and `timeout_ms` (default `30000`). `path` may be an absolute URL.
- **Configuration** — `PROMETHEUS_BASE_URL` (`PROMETHEUS_URL` fallback), optional
  `PROMETHEUS_TOKEN`, or `PROMETHEUS_USERNAME`/`PROMETHEUS_PASSWORD` for basic auth.
  Custom `headers` override configured headers. Reverse-proxy path prefixes are preserved.
- **Encoding** — `params` values may be strings, numbers, booleans or arrays;
  arrays repeat the query key, supporting `match[]`. JSON bodies are serialized;
  string bodies are sent verbatim (set `content-type` for form-encoded requests).
- **Output** — `{status_code, data}` with the complete JSON response or text for
  non-JSON endpoints. HTTP errors and Prometheus `status: "error"` responses
  retain their response data and set `isError: true`.

```json
{"tool":"prometheus_tool","arguments":{"path":"/api/v1/query","params":{"query":"up"}}}
{"tool":"prometheus_tool","arguments":{"path":"/api/v1/query_range","params":{"query":"rate(http_requests_total[5m])","start":1700000000,"end":1700000600,"step":"15s"}}}
{"tool":"prometheus_tool","arguments":{"path":"/api/v1/series","params":{"match[]":["up","process_cpu_seconds_total"]}}}
{"tool":"prometheus_tool","arguments":{"path":"/-/reload","method":"POST"}}
```

## Configuration

| Environment variable  | Description                                                        | Default                  |
| --------------------- | ------------------------------------------------------------------ | ------------------------ |
| `EMBEDDING_PROTOCOL`  | Embedding provider protocol (`openai` is the only supported value) | `openai`                 |
| `EMBEDDING_MODEL`     | Embedding model id (e.g. `text-embedding-v4`)                      | —                        |
| `EMBEDDING_BASE_URL`  | OpenAI-compatible `embeddings` endpoint base URL                   | —                        |
| `EMBEDDING_API_KEY`   | API key (falls back to `OPENAI_API_KEY`)                           | —                        |
| `REDIS_URL`           | Redis connection string (used only by `redis_tool`)                | `redis://localhost:6379` |
| `YUKINO_DOCS_DIR`     | Local docs directory to index                                      | `~/.yukino/docs`         |
| `YUKINO_INDEX_DB`     | SQLite file holding the docs vector index                          | `~/.yukino/index.sqlite` |
| `GITHUB_TOKEN`        | Optional GitHub CLI token (gh also supports stored login)          | —                        |
| `GH_TOKEN`            | Native GitHub CLI token; takes precedence over `GITHUB_TOKEN`      | —                        |
| `GITHUB_BASE_URL`     | Legacy API URL; its hostname is used when `GH_HOST` is unset       | —                        |
| `POSTGRES_URL`        | PostgreSQL connection URL for `postgres_tool`                      | —                        |
| `POSTGRESQL_URL`      | Fallback for `POSTGRES_URL`                                        | —                        |
| `DATABASE_URL`        | Final PostgreSQL connection URL fallback                           | —                        |
| `MYSQL_URL`           | MySQL connection URL for `mysql_tool`                              | —                        |
| `MONGODB_URL`         | MongoDB connection URL for `mongodb_tool`                          | —                        |
| `MONGODB_DATABASE`    | Default MongoDB database (otherwise uses the URL database)         | —                        |
| `PROMETHEUS_BASE_URL` | Prometheus HTTP base URL                                           | —                        |
| `PROMETHEUS_URL`      | Fallback for `PROMETHEUS_BASE_URL`                                 | —                        |
| `PROMETHEUS_TOKEN`    | Optional Prometheus bearer token                                   | —                        |
| `PROMETHEUS_USERNAME` | Optional Prometheus basic-auth username                            | —                        |
| `PROMETHEUS_PASSWORD` | Optional Prometheus basic-auth password                            | —                        |
| `GH_HOST`             | Optional GitHub CLI Enterprise hostname                            | —                        |
| `GH_ENTERPRISE_TOKEN` | Optional GitHub CLI Enterprise token                               | —                        |
| `HOST`                | HTTP transport bind address                                        | `127.0.0.1`              |
| `PORT`                | HTTP transport port                                                | `3300`                   |

Both **stdio** (default) and **HTTP** transports are supported: `--http` (or
`MCP_TRANSPORT=http`) starts `startHttpServer`, which serves the same tools over
streamable HTTP (`POST /mcp`) and legacy SSE (`GET /sse` + `POST /messages`).
The HTTP endpoints are **unauthenticated**; keep `HOST` bound to localhost (the
default) and only enable HTTP on a trusted machine.

## Getting started

Requires **Node.js 24 or newer**: the docs index is built on the built-in
`node:sqlite` module, which does not exist on older runtimes.

Run from the repository root:

```sh
pnpm install
cp apps/mcp/.env.example apps/mcp/.env   # configure the embedding provider
pnpm --filter @yukino.js/mcp dev         # build UI + run over stdio
```

| Command                                  | Description                        |
| ---------------------------------------- | ---------------------------------- |
| `pnpm --filter @yukino.js/mcp dev`       | Build UI + run over stdio          |
| `pnpm --filter @yukino.js/mcp build`     | Bundle (tsup) + build UI           |
| `pnpm --filter @yukino.js/mcp test`      | Build UI + vitest                  |
| `pnpm --filter @yukino.js/mcp happy:fix` | Typecheck, format, build and tests |
| `pnpm build` (root)                      | Build every workspace app          |

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
│       ├── names.ts    # explicit catalog of every public MCP tool name
│       ├── types.ts    # ToolModule interface
│       ├── docs/       # RAG pipeline (chunk/embed/index/retrieve)
│       ├── create-app/ # MCP App create tool + UI shell
│       ├── github/     # arbitrary gh CLI commands + subprocess lifecycle
│       ├── operations/ # shared database schemas, results and errors
│       ├── postgres/   # unrestricted PostgreSQL SQL
│       ├── mysql/      # unrestricted MySQL SQL
│       ├── redis/      # arbitrary Redis command batches
│       ├── mongodb/    # arbitrary MongoDB commands + Extended JSON
│       └── prometheus/ # general Prometheus HTTP operations
└── tests/
```

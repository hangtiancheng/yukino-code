# @yukino.js/mcp

The **Yukino MCP server** — an official collection of MCP tools for the
[Yukino CLI](../../README.md). It ships three tool groups today: a semantic
`docs` RAG tool over your local Yukino knowledge base, a `create_app`
tool that lets agents deliver interactive MCP Apps with a sandboxed UI, and
a `chrome` tool group that drives the user's browser through the Yukino
Chrome extension.

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

## Configuration

| Environment variable | Description                                      | Default                  |
| -------------------- | ------------------------------------------------ | ------------------------ |
| `EMBEDDING_MODEL`    | Embedding model id (e.g. `text-embedding-v4`)    | —                        |
| `EMBEDDING_BASE_URL` | OpenAI-compatible `embeddings` endpoint base URL | —                        |
| `EMBEDDING_API_KEY`  | API key (falls back to `OPENAI_API_KEY`)         | —                        |
| `REDIS_URL`          | Redis connection string                          | `redis://localhost:6379` |
| `REDIS_INDEX_NAME`   | Redis index name                                 | `idx:yukino`             |
| `REDIS_KEY_PREFIX`   | Redis key prefix                                 | `yukino:`                |
| `YUKINO_DOCS_DIR`    | Local docs directory to index                    | `~/.yukino/docs`         |

Both **stdio** (default) and **HTTP** transports are supported — `startHttpServer`
serves the same tools over streamable HTTP (`POST /mcp`) and legacy SSE
(`GET /sse` + `POST /messages`). The HTTP endpoints are **unauthenticated**;
keep `HOST` bound to localhost (the default) and only enable HTTP on a
trusted machine — with the `chrome` tools registered, anyone who can reach
the port can drive the browser.

## Getting started

Run from the repository root:

```sh
pnpm install
cp apps/mcp/.env.example apps/mcp/.env   # configure embedding + Redis
pnpm --filter @yukino.js/mcp dev         # build UI + run over stdio
```

| Command                              | Description                  |
| ------------------------------------ | ---------------------------- |
| `pnpm build:mcp` (root)              | Build wasm + marked-terminal |
| `pnpm --filter @yukino.js/mcp build` | Bundle (tsup) + build UI     |
| `pnpm --filter @yukino.js/mcp test`  | Build UI + vitest            |

## Layout

```
mcp/
├── src/
│   ├── main.ts         # stdio/HTTP entrypoint + shutdown
│   ├── server.ts       # MCP server + tool registration
│   ├── http.ts         # streamable HTTP transport
│   ├── shared/         # config (zod) + logger
│   └── tools/
│       ├── docs/       # RAG pipeline (chunk/embed/index/retrieve)
│       ├── create-app/ # MCP App create tool + UI shell
│       └── chrome/     # browser automation via the Chrome extension socket
└── tests/
```

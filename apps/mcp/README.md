# @yukino.js/mcp

The **Yukino MCP server** — an official collection of MCP tools for the
[Yukino CLI](../../README.md). It includes a semantic
`docs_tool` RAG tool over your local Yukino knowledge base, a `create_app`
tool that lets agents deliver interactive MCP Apps with a sandboxed UI,
and a `github_tool` that runs GitHub CLI commands, plus PostgreSQL, MySQL, Redis, MongoDB, Prometheus, Grafana, MinIO/S3, ClickHouse, etcd, Milvus and Kafka tools.

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

### `grafana_tool`

Call any Grafana HTTP API endpoint. `path` defaults to `/api/health`. Use
`/api/search` to list dashboards/folders, `/api/dashboards/uid/{uid}` to fetch
(GET) or save (POST) a dashboard, `/api/folders`, `/api/datasources` and
`/api/datasources/{id}` for provisioning, `/api/ds/query` for proxied datasource
queries, `/api/annotations`, `/api/ruler/...` and `/api/v1/provisioning/*` for
alerting, and `/api/admin`, `/api/org`, `/api/users`, `/api/serviceaccounts` for
administration. There is no endpoint allowlist; Grafana RBAC and the credential's
role still govern what succeeds.

This tool shares the same authenticated HTTP-passthrough plumbing as
`prometheus_tool` (`src/tools/operations/http.ts`).

- **Input** — optional `base_url`, `path`, `method` (default `GET`), `params`,
  `body`, `headers`, and `timeout_ms` (default `30000`). `path` may be an absolute
  URL. `body` is JSON (dashboard models, `/api/ds/query` payloads) or a raw string
  sent verbatim.
- **Configuration** — `GRAFANA_BASE_URL` (`GRAFANA_URL` fallback), with either a
  bearer token (`GRAFANA_TOKEN`, `GRAFANA_API_KEY` fallback — a service-account
  token or API key) or basic auth (`GRAFANA_USERNAME`/`GRAFANA_PASSWORD`). Custom
  `headers` override configured auth and can set `X-Grafana-Org-Id`.
- **Output** — `{status_code, data}` with the complete JSON response or text for
  non-JSON endpoints. Non-2xx responses retain their body and set `isError: true`.

```json
{"tool":"grafana_tool","arguments":{}}
{"tool":"grafana_tool","arguments":{"path":"/api/search","params":{"query":"my-dashboard"}}}
{"tool":"grafana_tool","arguments":{"path":"/api/dashboards/uid/abc123"}}
{"tool":"grafana_tool","arguments":{"path":"/api/ds/query","method":"POST","body":{"queries":[{"refId":"A","datasource":{"uid":"prometheus"},"expr":"up"}]}}}
{"tool":"grafana_tool","arguments":{"path":"/api/dashboards/db","method":"POST","body":{"dashboard":{"title":"Demo","panels":[]},"overwrite":true}}}
```

### `minio_tool`

Call any S3-compatible (MinIO) REST operation with full account privileges:
list buckets, list/create/delete buckets, get/put/head/delete objects, multipart
uploads, and bucket subresources such as versioning, policy and lifecycle. There
is no operation allowlist. Requests are signed with **AWS Signature V4**
(path-style) using a hand-rolled signer (`src/tools/minio/s3.ts`), so no AWS SDK
is required.

- **Input** — `method` (default `GET`), optional `bucket`, `key`, `query`
  (subresource parameters; use an empty string for valueless ones like
  `location`, `uploads`, `versioning`, `delete`), `headers`, and a body via
  `body` (UTF-8 XML/JSON), `body_base64` (binary) or `body_path` (local file).
  `response_format` (`auto`/`text`/`base64`/`none`), `max_bytes` and `save_path`
  control how the response body is returned; large or binary bodies can be
  written straight to `save_path`.
- **Configuration** — `MINIO_URL` (`S3_ENDPOINT` fallback),
  `MINIO_ACCESS_KEY`/`MINIO_SECRET_KEY` (`AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`
  fallback), `MINIO_REGION` (`AWS_REGION`/`AWS_DEFAULT_REGION` fallback, default
  `us-east-1`) and optional `MINIO_SESSION_TOKEN`. Per-call `endpoint`/`region`
  override the environment.
- **Output** — `{status_code, headers, size, body?|body_base64?, truncated?,
saved_to?}`. Non-2xx responses keep their body and set `isError: true`.

```json
{"tool":"minio_tool","arguments":{}}
{"tool":"minio_tool","arguments":{"bucket":"data","query":{"list-type":2,"prefix":"logs/"}}}
{"tool":"minio_tool","arguments":{"method":"PUT","bucket":"data","key":"hello.txt","body":"hello world","headers":{"content-type":"text/plain"}}}
{"tool":"minio_tool","arguments":{"bucket":"data","key":"hello.txt","save_path":"/tmp/hello.txt"}}
{"tool":"minio_tool","arguments":{"method":"DELETE","bucket":"data","key":"hello.txt"}}
```

### `clickhouse_tool`

Execute arbitrary ClickHouse SQL over the HTTP interface with the account's full
privileges: queries, inserts, DDL, mutations, `system` tables and administrative
statements. There is no SQL allowlist or read-only mode.

- **Input** — `sql`, optional `params` (parameterized-query values sent as
  `param_<name>` for `{name:Type}` placeholders), `settings` (engine settings as
  query parameters, e.g. `max_execution_time`, `readonly`), `database`, `format`
  (`default_format`, default `JSON`), and `data`/`data_base64` for
  `INSERT ... FORMAT <fmt>` (the SQL moves to the `query` parameter and the rows
  become the body). Optional `user`/`password`/`api_key` and `headers`.
- **Configuration** — `CLICKHOUSE_URL` (`CLICKHOUSE_HTTP_URL` fallback) or
  `connection_url`; `CLICKHOUSE_USER`/`CLICKHOUSE_PASSWORD` (basic auth) and
  `CLICKHOUSE_DATABASE`.
- **Output** — `{status_code, format, data}`. JSON-family formats are parsed into
  `data`; other formats return text. Non-2xx responses set `isError: true`.

```json
{"tool":"clickhouse_tool","arguments":{"sql":"SELECT number FROM system.numbers LIMIT 5"}}
{"tool":"clickhouse_tool","arguments":{"sql":"SELECT {id:UInt64} AS id","params":{"id":42}}}
{"tool":"clickhouse_tool","arguments":{"sql":"INSERT INTO t FORMAT JSONEachRow","data":"{\"a\":1}\n","format":"JSONEachRow"}}
```

### `etcd_tool`

Call any etcd **v3 JSON-gateway** endpoint with full privileges: kv
range/put/deleterange/txn/compaction, lease grant/revoke/keepalive/timetolive,
auth, cluster member management and maintenance (status/defragment/alarm/hash).
There is no endpoint allowlist.

Because the gateway maps proto3 `bytes` to base64 — where a plain string like
`"test"` would be silently mis-decoded — the tool accepts **plain UTF-8 strings**
for `key`, `range_end` and `value`, base64-encodes them on the way in, and decodes
response keys/values back to strings (binary values stay base64). Set
`raw_base64: true` to send and receive verbatim base64 instead.

- **Input** — `path` (default `/v3/kv/range`), `method` (default `POST`), `body`
  (JSON request document), `headers` (e.g. `{authorization: '<token>'}` after
  `/v3/auth/authenticate`), `raw_base64`, `base_url`, `timeout_ms`. Streaming
  endpoints (`/v3/watch`, `/v3/maintenance/snapshot`) are not supported.
- **Configuration** — `ETCD_URL` (`ETCD_ENDPOINTS` fallback; a compose-style
  `etcd:2379` is normalized to `http://etcd:2379`) or `base_url`. The reference
  compose service does not publish 2379 to the host, so point `ETCD_URL` at a
  reachable endpoint or publish the port.
- **Output** — `{status_code, data}` with decoded keys/values. Non-2xx responses
  set `isError: true`.

```json
{"tool":"etcd_tool","arguments":{"path":"/v3/kv/put","body":{"key":"app/name","value":"yukino"}}}
{"tool":"etcd_tool","arguments":{"path":"/v3/kv/range","body":{"key":"app/"}}}
{"tool":"etcd_tool","arguments":{"path":"/v3/lease/grant","body":{"TTL":"60","ID":"0"}}}
{"tool":"etcd_tool","arguments":{"path":"/v3/maintenance/status","body":{}}}
```

### `milvus_tool`

Call any Milvus **RESTful API v2** endpoint with full privileges: collections
(list/create/describe/drop/has/load/release/rename/alter), entities
(insert/upsert/delete/get/query/search/hybrid_search), indexes, partitions,
databases, aliases, users/roles/grants, import and jobs. There is no endpoint
allowlist.

- **Input** — `path` (default `/v2/vectordb/collections/list`), `method` (default
  `POST`), `body` (JSON request document), optional `database` (injected as
  `dbName`), `token` (Bearer override) and `headers`.
- **Configuration** — `MILVUS_URL` (`MILVUS_ADDRESS` fallback) or `base_url`;
  authentication from `MILVUS_TOKEN` or `MILVUS_USERNAME`/`MILVUS_PASSWORD`
  (combined as `username:password`); default database from `MILVUS_DATABASE`. The
  REST API shares the gRPC port (default `19530`); health/metrics on `9091` are
  reachable with an absolute `base_url`.
- **Output** — `{status_code, data}`. A non-zero Milvus `code` or non-2xx status
  sets `isError: true`.

```json
{"tool":"milvus_tool","arguments":{}}
{"tool":"milvus_tool","arguments":{"path":"/v2/vectordb/collections/describe","body":{"collectionName":"docs"}}}
{"tool":"milvus_tool","arguments":{"path":"/v2/vectordb/entities/query","body":{"collectionName":"docs","filter":"id > 0","outputFields":["id","vector"],"limit":10}}}
```

### `kafka_tool`

Operate an Apache Kafka cluster through **@platformatic/kafka** with full
client privileges. Choose an `operation`: `produce`, `consume`, `list_topics`,
`describe_topics`, `describe_cluster`, `create_topic`, `delete_topic`,
`create_partitions`, `watermark_offsets` and `committed_offsets`. Client options are passed through `config`, including nested `tls` and `sasl`
objects, `requestTimeout`, `retries`, `acks` (-1, 0 or 1) and `compression`.
Legacy librdkafka configuration keys are rejected.

- **Input** — `operation` plus operation-specific fields: `topic`/`topics`,
  `messages` (`{key?, value, partition?, timestamp?, headers?}`; a `null` value
  writes a tombstone), `assignments` (explicit partitions for `consume`, bypassing
  group subscription), `partitions`, `group_id`, `from_beginning`, `auto_commit`,
  `max_messages`, `num_partitions`, `replication_factor`, `topic_config`,
  `encoding` (`utf8` default or `base64` for binary keys/values) and `timeout_ms`
  (the consume window and per-request timeout). `consume` collects at most
  `max_messages` within `timeout_ms` and then disconnects.
- **Configuration** — `KAFKA_BROKERS` (default `localhost:9092`) or `brokers`,
  `KAFKA_CLIENT_ID` (default `yukino-mcp`), and optional
  `KAFKA_SECURITY_PROTOCOL`/`KAFKA_SASL_MECHANISM`/`KAFKA_USERNAME`/`KAFKA_PASSWORD`.
  Each call opens and closes its own client(s).
- **Output** — `{operation, data}`. `data` shape depends on the operation, e.g.
  `{produced}` for produce and `{count, group_id, messages}` for consume.
- **Runtime** — the Kafka client runs in JavaScript; no librdkafka build is required.
  Node.js 24.6 or newer is required.
- **Offsets** — subscriptions resume committed positions, falling back to earliest
  with `from_beginning`, otherwise latest. Explicit assignments bypass group
  subscription. `auto_commit` commits only returned records; prefetched records
  are never committed. Uncommitted offsets use -1001. Unsafe integer offsets
  are returned as decimal strings. `describe_cluster` returns `brokers`,
  `controller_id` and `cluster_id`.

```json
{"tool":"kafka_tool","arguments":{"operation":"list_topics"}}
{"tool":"kafka_tool","arguments":{"operation":"list_topics","config":{"tls":{},"sasl":{"mechanism":"SCRAM-SHA-512","username":"user","password":"replace-me"}}}}
{"tool":"kafka_tool","arguments":{"operation":"produce","topic":"events","messages":[{"key":"k1","value":"v1"}]}}
{"tool":"kafka_tool","arguments":{"operation":"consume","topics":["events"],"group_id":"demo","from_beginning":true,"max_messages":10,"timeout_ms":5000}}
{"tool":"kafka_tool","arguments":{"operation":"consume","assignments":[{"topic":"events","partition":0,"offset":0}],"max_messages":10}}
{"tool":"kafka_tool","arguments":{"operation":"create_topic","topic":"new-topic","num_partitions":3,"replication_factor":1}}
{"tool":"kafka_tool","arguments":{"operation":"watermark_offsets","topic":"events"}}
```

## Configuration

| Environment variable      | Description                                                        | Default                  |
| ------------------------- | ------------------------------------------------------------------ | ------------------------ |
| `EMBEDDING_PROTOCOL`      | Embedding provider protocol (`openai` is the only supported value) | `openai`                 |
| `EMBEDDING_MODEL`         | Embedding model id (e.g. `text-embedding-v4`)                      | —                        |
| `EMBEDDING_BASE_URL`      | OpenAI-compatible `embeddings` endpoint base URL                   | —                        |
| `EMBEDDING_API_KEY`       | API key (falls back to `OPENAI_API_KEY`)                           | —                        |
| `REDIS_URL`               | Redis connection string (used only by `redis_tool`)                | `redis://localhost:6379` |
| `YUKINO_DOCS_DIR`         | Local docs directory to index                                      | `~/.yukino/docs`         |
| `YUKINO_INDEX_DB`         | SQLite file holding the docs vector index                          | `~/.yukino/index.sqlite` |
| `GITHUB_TOKEN`            | Optional GitHub CLI token (gh also supports stored login)          | —                        |
| `GH_TOKEN`                | Native GitHub CLI token; takes precedence over `GITHUB_TOKEN`      | —                        |
| `GITHUB_BASE_URL`         | Legacy API URL; its hostname is used when `GH_HOST` is unset       | —                        |
| `POSTGRES_URL`            | PostgreSQL connection URL for `postgres_tool`                      | —                        |
| `POSTGRESQL_URL`          | Fallback for `POSTGRES_URL`                                        | —                        |
| `DATABASE_URL`            | Final PostgreSQL connection URL fallback                           | —                        |
| `MYSQL_URL`               | MySQL connection URL for `mysql_tool`                              | —                        |
| `MONGODB_URL`             | MongoDB connection URL for `mongodb_tool`                          | —                        |
| `MONGODB_DATABASE`        | Default MongoDB database (otherwise uses the URL database)         | —                        |
| `PROMETHEUS_BASE_URL`     | Prometheus HTTP base URL                                           | —                        |
| `PROMETHEUS_URL`          | Fallback for `PROMETHEUS_BASE_URL`                                 | —                        |
| `PROMETHEUS_TOKEN`        | Optional Prometheus bearer token                                   | —                        |
| `PROMETHEUS_USERNAME`     | Optional Prometheus basic-auth username                            | —                        |
| `PROMETHEUS_PASSWORD`     | Optional Prometheus basic-auth password                            | —                        |
| `GRAFANA_BASE_URL`        | Grafana HTTP base URL for `grafana_tool` (`GRAFANA_URL` fallback)  | —                        |
| `GRAFANA_TOKEN`           | Grafana bearer token (service-account token or API key)            | —                        |
| `GRAFANA_API_KEY`         | Fallback for `GRAFANA_TOKEN`                                       | —                        |
| `GRAFANA_USERNAME`        | Grafana basic-auth username                                        | —                        |
| `GRAFANA_PASSWORD`        | Grafana basic-auth password                                        | —                        |
| `MINIO_URL`               | MinIO/S3 endpoint for `minio_tool` (`S3_ENDPOINT` fallback)        | —                        |
| `MINIO_ACCESS_KEY`        | S3 access key (`AWS_ACCESS_KEY_ID` fallback)                       | —                        |
| `MINIO_SECRET_KEY`        | S3 secret key (`AWS_SECRET_ACCESS_KEY` fallback)                   | —                        |
| `MINIO_REGION`            | S3 signing region (`AWS_REGION`/`AWS_DEFAULT_REGION` fallback)     | `us-east-1`              |
| `MINIO_SESSION_TOKEN`     | Optional S3 session token (`AWS_SESSION_TOKEN` fallback)           | —                        |
| `CLICKHOUSE_URL`          | ClickHouse HTTP URL for `clickhouse_tool` (`CLICKHOUSE_HTTP_URL`)  | —                        |
| `CLICKHOUSE_USER`         | ClickHouse user                                                    | —                        |
| `CLICKHOUSE_PASSWORD`     | ClickHouse password                                                | —                        |
| `CLICKHOUSE_DATABASE`     | Default ClickHouse database                                        | —                        |
| `ETCD_URL`                | etcd v3 gateway URL for `etcd_tool` (`ETCD_ENDPOINTS` fallback)    | —                        |
| `MILVUS_URL`              | Milvus REST URL for `milvus_tool` (`MILVUS_ADDRESS` fallback)      | —                        |
| `MILVUS_TOKEN`            | Milvus bearer token (or `MILVUS_USERNAME`/`MILVUS_PASSWORD`)       | —                        |
| `MILVUS_DATABASE`         | Default Milvus database                                            | —                        |
| `KAFKA_BROKERS`           | Kafka broker CSV for `kafka_tool`                                  | `localhost:9092`         |
| `KAFKA_CLIENT_ID`         | Kafka client id                                                    | `yukino-mcp`             |
| `KAFKA_SECURITY_PROTOCOL` | Kafka `security.protocol` (e.g. `SASL_SSL`)                        | —                        |
| `KAFKA_SASL_MECHANISM`    | Kafka `sasl.mechanisms` (e.g. `SCRAM-SHA-512`)                     | —                        |
| `KAFKA_USERNAME`          | Kafka SASL username                                                | —                        |
| `KAFKA_PASSWORD`          | Kafka SASL password                                                | —                        |
| `GH_HOST`                 | Optional GitHub CLI Enterprise hostname                            | —                        |
| `GH_ENTERPRISE_TOKEN`     | Optional GitHub CLI Enterprise token                               | —                        |
| `HOST`                    | HTTP transport bind address                                        | `127.0.0.1`              |
| `PORT`                    | HTTP transport port                                                | `3300`                   |

Both **stdio** (default) and **HTTP** transports are supported: `--http` (or
`MCP_TRANSPORT=http`) starts `startHttpServer`, which serves the same tools over
streamable HTTP (`POST /mcp`).
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
│   ├── http.ts         # h3 app: streamable HTTP transport
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
│       ├── prometheus/ # general Prometheus HTTP operations
│       ├── grafana/    # general Grafana HTTP operations
│       ├── minio/      # S3 REST passthrough + hand-rolled SigV4 signer
│       ├── clickhouse/ # arbitrary ClickHouse SQL over HTTP
│       ├── etcd/       # etcd v3 gateway passthrough + base64 key/value codec
│       ├── milvus/     # Milvus RESTful API v2 passthrough
│       └── kafka/      # Kafka produce/consume/admin via @platformatic/kafka
└── tests/
```

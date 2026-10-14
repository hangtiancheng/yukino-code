# Yukino MCP (Go)

`apps/mcp-go` provides the same 15 tools as `apps/mcp`, with stdio,
stateless Streamable HTTP at `/mcp`, and legacy SSE at `/sse` with
`POST /messages?sessionId=...`.

Build with Go 1.26; Kafka uses the pure Go
[franz-go client](https://github.com/twmb/franz-go). A C compiler and librdkafka
are no longer required, and `CGO_ENABLED=0` builds are supported.

```sh
cd apps/mcp-go
cp .example.jsonc .config.jsonc
# Edit .config.jsonc with your backend endpoints and credentials.
go build -o yukino-mcp ./cmd/yukino-mcp
./yukino-mcp                         # stdio by default
./yukino-mcp --http                  # HTTP on configured host/port
./yukino-mcp --config /path/mcp.json  # choose a JSON or JSONC file
go test -race ./...
go vet ./...
```

Configuration is read once before the modules start. The default file is
`.config.jsonc` in the process working directory; `--config` selects another file.
JSONC supports comments and trailing commas. Missing files, unknown fields and
invalid ports are startup errors. `.env`, `DOTENV_CONFIG_*`, and backend or
transport environment variables are no longer configuration inputs. GitHub CLI
still supports its own `gh auth login` and native environment authentication.
Relative file paths resolve against the process working directory.

[.example.jsonc](.example.jsonc) documents every backend section. Omit unused
sections. Transport settings are `transport` (`stdio` or `http`), `host` and
`port`; `--http` overrides `transport`. Documentation defaults to
`~/.yukino/docs` and `~/.yukino/index.sqlite`, overridable with `docs_dir` and
`index.db_path`. Embeddings use `embedding.protocol` (`openai`), `model`,
`base_url` and `api_key`; incomplete embedding settings disable the docs tools.

MySQL uses only [go-mysql-org](https://github.com/go-mysql-org/go-mysql) and takes
structured credentials in the `mysql` object. The unused go-sql-driver module
declared by the upstream parser is excluded from the build list:

```json
{
  "mysql": {
    "host": "localhost",
    "port": 3306,
    "username": "user",
    "password": "replace-me",
    "database": "db0",
    "timeout_ms": 10000
  }
}
```

`username` and `password` are required when `mysql` is present; an empty password
string is allowed. `socket` overrides TCP host/port. Optional settings include
`read_timeout_ms`, `write_timeout_ms`, `charset`, `collation`, `timezone`, `session`
(SQL expressions for session variables), and `tls`. TLS accepts `ca_file`,
`cert_file`/`key_file`, `server_name` and `insecure_skip_verify` (false by default).
MySQL accepts neither DSNs nor URLs, including the tool's former `connection_url`
argument. Call `mysql_tool` with `sql` and optional `params`; multiple statements,
transaction batches, field metadata and binary/large numeric values are retained.

Kafka uses `kafka.brokers` (CSV, default `localhost:9092`), `client_id`,
`security_protocol` (`PLAINTEXT`, `SSL`, `SASL_PLAINTEXT`, `SASL_SSL`),
`sasl_mechanism` (`PLAIN`, `SCRAM-SHA-256`, `SCRAM-SHA-512`), `username`, `password`
and optional `tls` with the same file fields as MySQL. Per-call `brokers` and
`client_id` override these values. The tool's `config` accepts `requestTimeout`,
`connectTimeout`, `retries` (integer), `retryDelay`, `acks` (-1/0/1), `compression`
(none/gzip/snappy/lz4/zstd), `groupId`, `maxWaitTime`, `maxBytes`,
`maxBytesPerPartition`, `autocreateTopics`, nested `tls`, and nested `sasl`
(`mechanism`, `username`, `password`, or `token` for `OAUTHBEARER`). Unknown or
legacy librdkafka keys are rejected. TypeScript uses @platformatic/kafka options;
its TLS object uses Node.js TLS options such as PEM `ca`, `cert` and `key`.

Kafka preserves all ten operations, binary values, headers and tombstones.
Subscription consumes resume committed positions, falling back to earliest with
`from_beginning`, otherwise latest. Explicit assignments bypass group membership,
use supplied offsets or resume stored positions, and return at most `max_messages`
within the consume window. `auto_commit` commits only returned records. Uncommitted
positions use -1001. `describe_cluster` returns `brokers`, `controller_id` and
`cluster_id` in both servers.

Tool argument schemas, annotations and app metadata are generated from TypeScript,
with an explicit Go MySQL schema adjustment to remove `connection_url`. Regenerate
from `apps/mcp` after changing a schema:

```sh
pnpm exec tsx --tsconfig tsconfig.json scripts/export-go-contract.ts
pnpm build:app
pnpm exec tsx --tsconfig tsconfig.json scripts/check-go-parity.ts
```

The parity check builds Go in a temporary directory, writes its JSON configuration,
and compares 15 contracts, validation, Unicode apps, local HTTP fixtures and the
RAG refresh/recovery/deletion flow. Set `GO=/path/to/go` if needed.

Go tests use local HTTP/MySQL fixtures and franz-go's `kfake` wire-level Kafka
cluster. TypeScript Kafka integration tests require a disposable broker; they
create and delete a unique topic. To run them against the same local fixture:

```sh
# Terminal 1, from apps/mcp-go; Ctrl-D stops the fixture.
go run ./internal/tools/kafka/testdata/broker
# Terminal 2, from apps/mcp; use the address printed by the fixture.
KAFKA_TEST_BROKERS=127.0.0.1:PORT pnpm test
```

Driver-specific options and backend errors can differ. Authentication and TLS
should be tested against the intended deployment.

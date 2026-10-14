# Yukino MCP (Go)

`apps/mcp-go` implements the same 15 public tools as `apps/mcp`, including
stdio, stateless Streamable HTTP at `/mcp`, and legacy SSE at `/sse` with
`POST /messages?sessionId=...`. Configuration uses the same environment
variables and loads `.env` from the process working directory.

Build with Go 1.26 and a C compiler:

```sh
cd apps/mcp-go
CGO_ENABLED=1 go build -o yukino-mcp ./cmd/yukino-mcp
./yukino-mcp                 # stdio
./yukino-mcp --http          # HTTP; MCP_HOST / MCP_PORT
go test -race ./...
go vet ./...
```

Kafka uses librdkafka 2.12 through confluent-kafka-go, matching the TS native
engine and accepting its configuration keys. CGO is required. The dependency
bundles librdkafka for Linux glibc and musl on amd64/arm64, macOS on amd64/arm64,
and Windows amd64. Alpine builds require `-tags musl`. Cross compilation also
requires a C compiler and native libraries for the target. GSSAPI/Kerberos
requires an installed librdkafka built with that support and `-tags dynamic`;
see the [Kafka client build instructions](https://github.com/confluentinc/confluent-kafka-go/tree/v2.12.0#installing-librdkafka).

Tool schemas, annotations and app metadata are generated from the TS server.
After changing a TS input schema, regenerate the Go contract from `apps/mcp`:

```sh
node_modules/.bin/tsx --tsconfig tsconfig.json scripts/export-go-contract.ts
```

For a direct comparison of both running MCP servers, build the TS app shell
with `pnpm build:fe`, then run from `apps/mcp`:

```sh
node_modules/.bin/tsx --tsconfig tsconfig.json scripts/check-go-parity.ts
```

The check builds Go into a temporary directory, compares all 15 contracts, and
exercises argument validation, Unicode apps, local HTTP fixtures and the complete
RAG refresh/recovery/deletion flow. Set `GO=/path/to/go` if Go is not on PATH.

Compatibility covers public arguments, defaults, validation, operation coverage
and normalized successful results. Driver-specific connection options,
backend error wording and native build availability can differ. MySQL column
metadata now has an explicit public representation in both servers, excluding
mysql2 packet buffers. PostgreSQL and MySQL retain SQL text types and large
integers; binary data uses the same Buffer JSON representation as TS. Kafka
stores only returned records' offsets, so closing a bounded consume call cannot
commit records that were not returned. Documentation uses UTF-16 chunk lengths,
the same float32 vector format and SQLite schema as TS.

Tests use local HTTP/protocol fixtures and librdkafka's mock cluster; deployment
authentication, TLS and administrative permissions still need verification
against the intended services.

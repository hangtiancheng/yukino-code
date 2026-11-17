# Yukino MCP (Go)

`apps/mcp` provides the same 15 tools as `packages/mcp`, with stdio,
stateless Streamable HTTP at `/mcp`, and legacy SSE at `/sse` with
`POST /messages?sessionId=...`.

Build with Go 1.26; Kafka uses the pure Go
[franz-go client](https://github.com/twmb/franz-go). A C compiler and librdkafka
are no longer required, and `CGO_ENABLED=0` builds are supported.

```sh
cd apps/mcp
cp .example.jsonc .config.jsonc
# Edit .config.jsonc with your backend endpoints and credentials.
go build -o yukino-mcp ./cmd/yukino-mcp
./yukino-mcp                         # stdio by default
./yukino-mcp --http                  # HTTP on configured host/port
./yukino-mcp --config /path/mcp.json  # choose a JSON or JSONC file
go test -race ./...
go vet ./...
```

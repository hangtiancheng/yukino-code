module github.com/hangtiancheng/yukino-code/apps/mcp-go

go 1.26.0

require (
	github.com/go-mysql-org/go-mysql v1.16.0
	github.com/google/jsonschema-go v0.4.3
	github.com/hangtiancheng/yukino.go/libs/yukino_http v0.0.1
	github.com/jackc/pgx/v5 v5.11.0
	github.com/modelcontextprotocol/go-sdk v1.8.0
	github.com/openai/openai-go v1.12.0
	github.com/redis/go-redis/v9 v9.23.0
	github.com/tidwall/jsonc v0.3.3
	github.com/twmb/franz-go v1.22.2
	github.com/twmb/franz-go/pkg/kadm v1.19.0
	github.com/twmb/franz-go/pkg/kfake v0.0.0-20261013022759-7b6cac30a57a
	go.mongodb.org/mongo-driver/v2 v2.9.2
	golang.org/x/text v0.42.0
	modernc.org/sqlite v1.60.1
)

require (
	filippo.io/edwards25519 v1.2.0 // indirect
	github.com/cespare/xxhash/v2 v2.3.0 // indirect
	github.com/coreos/go-semver v0.3.1 // indirect
	github.com/dustin/go-humanize v1.0.1 // indirect
	github.com/goccy/go-json v0.10.6 // indirect
	github.com/google/uuid v1.6.0 // indirect
	github.com/jackc/pgpassfile v1.0.0 // indirect
	github.com/jackc/pgservicefile v0.0.0-20240606120523-5a60cdf6a761 // indirect
	github.com/klauspost/compress v1.20.3 // indirect
	github.com/mattn/go-isatty v0.0.24 // indirect
	github.com/ncruces/go-strftime v1.0.0 // indirect
	github.com/pierrec/lz4/v4 v4.1.33 // indirect
	github.com/pingcap/errors v0.11.5-0.20260310054046-9c8b3586e4b2 // indirect
	github.com/pingcap/log v1.1.1-0.20260227082333-572e590d08f1 // indirect
	github.com/pingcap/tidb/pkg/parser v0.0.0-20260504140133-511dba1dbe17 // indirect
	github.com/remyoudompheng/bigfft v0.0.0-20230129092748-24d4a6f8daec // indirect
	github.com/segmentio/asm v1.1.3 // indirect
	github.com/segmentio/encoding v0.5.4 // indirect
	github.com/shopspring/decimal v1.4.0 // indirect
	github.com/tidwall/gjson v1.14.4 // indirect
	github.com/tidwall/match v1.1.1 // indirect
	github.com/tidwall/pretty v1.2.1 // indirect
	github.com/tidwall/sjson v1.2.5 // indirect
	github.com/twmb/franz-go/pkg/kmsg v1.15.0 // indirect
	github.com/xdg-go/pbkdf2 v1.0.0 // indirect
	github.com/xdg-go/scram v1.2.0 // indirect
	github.com/xdg-go/stringprep v1.0.4 // indirect
	github.com/yosida95/uritemplate/v3 v3.0.2 // indirect
	github.com/youmark/pkcs8 v0.0.0-20240726163527-a2c0da244d78 // indirect
	go.uber.org/atomic v1.12.0 // indirect
	go.uber.org/multierr v1.11.0 // indirect
	go.uber.org/zap v1.28.0 // indirect
	golang.org/x/crypto v0.57.0 // indirect
	golang.org/x/oauth2 v0.35.0 // indirect
	golang.org/x/sync v0.23.0 // indirect
	golang.org/x/sys v0.48.0 // indirect
	golang.org/x/time v0.15.0 // indirect
	gopkg.in/natefinch/lumberjack.v2 v2.2.1 // indirect
	modernc.org/libc v1.77.1 // indirect
	modernc.org/mathutil v1.7.1 // indirect
	modernc.org/memory v1.12.1 // indirect
)

// The upstream parser declares this unused driver; exclude it from the build list.
exclude github.com/go-sql-driver/mysql v1.7.1

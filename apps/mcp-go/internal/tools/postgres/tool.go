// Package postgres exposes the postgres_tool: arbitrary PostgreSQL SQL with
// full connection privileges, including multi-statement batches.
package postgres

import (
	"context"
	"encoding/json"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/hangtiancheng/yukino-code/apps/mcp-go/internal/config"
	"github.com/hangtiancheng/yukino-code/apps/mcp-go/internal/tools"
	"github.com/hangtiancheng/yukino-code/apps/mcp-go/internal/tools/operations"
)

const connectTimeout = 10 * time.Second

const description = "Execute arbitrary PostgreSQL SQL with full connection privileges: queries, writes, DDL, transactions and administrative statements. Multiple statements are supported when params is empty; put a complete transaction in one call. Returns every statement's rows, row count, command and field metadata. Uses postgres.url or connection_url."

// Module returns the postgres tool module.
func Module() tools.ToolModule {
	return tools.ToolModule{
		Name: "postgres",
		Register: func(server *mcp.Server) {
			tools.AddTool(server, &mcp.Tool{
				Name:        tools.PostgresTool,
				Title:       "PostgreSQL",
				Description: description,
				Annotations: operations.UnrestrictedAnnotations,
			}, handle)
		},
	}
}

func handle(ctx context.Context, _ *mcp.CallToolRequest, in operations.SQLInput) (*mcp.CallToolResult, any, error) {
	rawURL, err := operations.RequireConnection(in.ConnectionURL, config.Load().Postgres.URL, "postgres.url")
	if err != nil {
		return operations.ResultErr(tools.PostgresTool, err), nil, nil
	}

	connCfg, err := pgx.ParseConfig(rawURL)
	if err != nil {
		return operations.ResultErr(tools.PostgresTool, err), nil, nil
	}
	// Simple protocol enables multi-statement batches; it is only safe when no
	// parameters are bound (parameters require the extended protocol).
	if len(in.Params) == 0 {
		connCfg.DefaultQueryExecMode = pgx.QueryExecModeSimpleProtocol
	}

	connectCtx, cancel := context.WithTimeout(ctx, connectTimeout)
	defer cancel()
	conn, err := pgx.ConnectConfig(connectCtx, connCfg)
	if err != nil {
		return operations.ResultErr(tools.PostgresTool, err), nil, nil
	}
	defer conn.Close(context.Background())

	var results []any
	if len(in.Params) == 0 {
		results, err = execMultiStatement(ctx, conn.PgConn(), in.SQL)
	} else {
		results, err = execParams(ctx, conn, in.SQL, in.Params)
	}
	if err != nil {
		return operations.ResultErr(tools.PostgresTool, err), nil, nil
	}
	return operations.Result(map[string]any{"results": results}), nil, nil
}

// execMultiStatement runs a (possibly multi-statement) query over the simple
// protocol and returns one entry per result set, with text-format values.
func execMultiStatement(ctx context.Context, pg *pgconn.PgConn, sql string) ([]any, error) {
	mrr := pg.Exec(ctx, sql)
	rawResults, err := mrr.ReadAll()
	if err != nil {
		return nil, err
	}
	return normalizeResults(rawResults)
}

func normalizeResults(rawResults []*pgconn.Result) ([]any, error) {
	results := make([]any, 0, len(rawResults))
	types := pgtype.NewMap()
	for _, res := range rawResults {
		if res.Err != nil {
			return nil, res.Err
		}
		fields := make([]any, 0, len(res.FieldDescriptions))
		names := make([]string, len(res.FieldDescriptions))
		for i, fd := range res.FieldDescriptions {
			names[i] = fd.Name
			fields = append(fields, map[string]any{"name": fd.Name, "data_type_id": fd.DataTypeOID})
		}
		rows := make([]any, 0, len(res.Rows))
		for _, rawRow := range res.Rows {
			row := make(map[string]any, len(names))
			for i, col := range rawRow {
				if i < len(names) {
					if col == nil {
						row[names[i]] = nil
					} else {
						value, err := decodeText(types, res.FieldDescriptions[i].DataTypeOID, col)
						if err != nil {
							return nil, err
						}
						row[names[i]] = value
					}
				}
			}
			rows = append(rows, row)
		}
		results = append(results, map[string]any{
			"command":   commandWord(res.CommandTag.String()),
			"row_count": rowCount(res.CommandTag),
			"rows":      rows,
			"fields":    fields,
		})
	}
	return results, nil
}

// execParams uses text parameters with unspecified OIDs, as node-postgres does.
// The server infers each SQL type; JSON numbers and arrays never depend on Go
// driver's native float64-to-integer or []any encoding plans.
func execParams(ctx context.Context, conn *pgx.Conn, sql string, params []any) ([]any, error) {
	values := make([][]byte, len(params))
	for i, param := range params {
		if param == nil {
			continue
		}
		text, err := prepareParameter(param)
		if err != nil {
			return nil, err
		}
		values[i] = []byte(text)
	}
	result := conn.PgConn().ExecParams(ctx, sql, values, nil, nil, nil).Read()
	return normalizeResults([]*pgconn.Result{result})
}

func prepareParameter(value any) (string, error) {
	switch v := value.(type) {
	case string:
		return v, nil
	case []any:
		entries := make([]string, len(v))
		for i, entry := range v {
			if entry == nil {
				entries[i] = "NULL"
				continue
			}
			text, err := prepareParameter(entry)
			if err != nil {
				return "", err
			}
			if _, nested := entry.([]any); nested {
				entries[i] = text
			} else {
				entries[i] = "\"" + strings.ReplaceAll(strings.ReplaceAll(text, "\\", "\\\\"), "\"", "\\\"") + "\""
			}
		}
		return "{" + strings.Join(entries, ",") + "}", nil
	case map[string]any:
		raw, err := json.Marshal(v)
		return string(raw), err
	default:
		return operations.JSONValueToString(v), nil
	}
}

// commandWord extracts the leading command word from a PostgreSQL command tag
// (e.g. "SELECT 3" -> "SELECT", "INSERT 0 1" -> "INSERT").
func commandWord(tag string) string {
	if tag == "" {
		return ""
	}
	if idx := strings.IndexByte(tag, ' '); idx >= 0 {
		return tag[:idx]
	}
	return tag
}

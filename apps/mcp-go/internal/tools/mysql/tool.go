// Package mysql exposes the mysql_tool: arbitrary MySQL SQL with full
// connection privileges and multi-statement support.
package mysql

import (
	"context"
	"database/sql"
	"net/url"
	"strconv"
	"strings"
	"time"

	mysqldriver "github.com/go-sql-driver/mysql"
	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/hangtiancheng/yukino-code/apps/mcp-go/internal/config"
	"github.com/hangtiancheng/yukino-code/apps/mcp-go/internal/tools"
	"github.com/hangtiancheng/yukino-code/apps/mcp-go/internal/tools/operations"
)

const queryTimeout = 10 * time.Second

const description = "Execute arbitrary MySQL SQL with full connection privileges: queries, writes, DDL, transactions, administration and multiple statements. Put a complete transaction in one call. Optional ? parameters are supported. Returns query rows or mutation result headers and field metadata for all statements. Uses MYSQL_URL or connection_url."

// Module returns the mysql tool module.
func Module() tools.ToolModule {
	return tools.ToolModule{
		Name: "mysql",
		Register: func(server *mcp.Server) {
			mcp.AddTool(server, &mcp.Tool{
				Name:        tools.MySQLTool,
				Title:       "MySQL",
				Description: description,
				Annotations: operations.UnrestrictedAnnotations,
			}, handle)
		},
	}
}

func handle(ctx context.Context, _ *mcp.CallToolRequest, in operations.SQLInput) (*mcp.CallToolResult, any, error) {
	rawURL, err := operations.RequireConnection(in.ConnectionURL, config.Load().MySQL.URL, "MYSQL_URL")
	if err != nil {
		return operations.ResultErr(tools.MySQLTool, err), nil, nil
	}
	dsn, err := toDSN(rawURL)
	if err != nil {
		return operations.ResultErr(tools.MySQLTool, err), nil, nil
	}

	db, err := sql.Open("mysql", dsn)
	if err != nil {
		return operations.ResultErr(tools.MySQLTool, err), nil, nil
	}
	defer db.Close()
	db.SetMaxOpenConns(1)

	queryCtx, cancel := context.WithTimeout(ctx, queryTimeout)
	defer cancel()

	rows, err := db.QueryContext(queryCtx, in.SQL, in.Params...)
	if err != nil {
		return operations.ResultErr(tools.MySQLTool, err), nil, nil
	}
	defer rows.Close()

	var results []any
	var fields []any
	for {
		setRows, setFields, err := collectResultSet(rows)
		if err != nil {
			return operations.ResultErr(tools.MySQLTool, err), nil, nil
		}
		results = append(results, setRows)
		fields = append(fields, setFields)
		if !rows.NextResultSet() {
			if err := rows.Err(); err != nil {
				return operations.ResultErr(tools.MySQLTool, err), nil, nil
			}
			break
		}
	}

	// mysql2 returns a bare rows array / fields array for a single statement and
	// arrays of results for multi-statement batches. Mirror that shape.
	out := map[string]any{"results": results, "fields": fields}
	if len(results) == 1 {
		out["results"] = results[0]
		out["fields"] = fields[0]
	}
	return operations.Result(out), nil, nil
}

// collectResultSet reads one result set into a rows slice and a fields slice.
// A result set without columns (a mutation OK packet) yields an empty object.
func collectResultSet(rows *sql.Rows) (any, any, error) {
	columns, err := rows.Columns()
	if err != nil {
		return nil, nil, err
	}
	if len(columns) == 0 {
		// Mutation / DDL result set: database/sql does not surface affectedRows
		// through Query, so report an empty header object.
		return map[string]any{}, nil, nil
	}

	colTypes, err := rows.ColumnTypes()
	fields := make([]any, 0, len(columns))
	if err == nil {
		for _, ct := range colTypes {
			fields = append(fields, map[string]any{
				"name":      ct.Name(),
				"data_type": ct.DatabaseTypeName(),
			})
		}
	} else {
		for _, name := range columns {
			fields = append(fields, map[string]any{"name": name})
		}
	}

	collected := make([]any, 0)
	for rows.Next() {
		values := make([]any, len(columns))
		pointers := make([]any, len(columns))
		for i := range values {
			pointers[i] = &values[i]
		}
		if err := rows.Scan(pointers...); err != nil {
			return nil, nil, err
		}
		row := make(map[string]any, len(columns))
		for i, name := range columns {
			row[name] = normalizeValue(values[i])
		}
		collected = append(collected, row)
	}
	if err := rows.Err(); err != nil {
		return nil, nil, err
	}
	return collected, fields, nil
}

// normalizeValue converts driver values to JSON-friendly forms: NULL stays nil,
// byte slices become numbers when unambiguous and strings otherwise, and times
// pass through for RFC 3339 marshaling.
func normalizeValue(v any) any {
	switch value := v.(type) {
	case nil:
		return nil
	case []byte:
		s := string(value)
		if i, err := strconv.ParseInt(s, 10, 64); err == nil {
			return i
		}
		if strings.ContainsAny(s, ".eE") {
			if f, err := strconv.ParseFloat(s, 64); err == nil {
				return f
			}
		}
		return s
	case time.Time:
		return value
	default:
		return v
	}
}

// toDSN converts a mysql:// URL (or passes through an existing DSN) into a
// go-sql-driver DSN with multi-statements and time parsing enabled.
func toDSN(raw string) (string, error) {
	if !strings.Contains(raw, "://") {
		return raw, nil
	}
	u, err := url.Parse(raw)
	if err != nil {
		return "", err
	}
	cfg := mysqldriver.NewConfig()
	cfg.Net = "tcp"
	cfg.Addr = u.Host
	if u.User != nil {
		cfg.User = u.User.Username()
		if password, ok := u.User.Password(); ok {
			cfg.Passwd = password
		}
	}
	cfg.DBName = strings.TrimPrefix(u.Path, "/")
	cfg.MultiStatements = true
	cfg.ParseTime = true
	return cfg.FormatDSN(), nil
}

// Package mysql executes SQL through the native MySQL protocol, retaining every
// OK packet and row set in a multi-statement response.
package mysql

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"math"
	"net"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"

	client "github.com/go-mysql-org/go-mysql/client"
	wire "github.com/go-mysql-org/go-mysql/mysql"
	mysqldriver "github.com/go-sql-driver/mysql"
	"github.com/hangtiancheng/yukino-code/apps/mcp-go/internal/config"
	"github.com/hangtiancheng/yukino-code/apps/mcp-go/internal/tools"
	"github.com/hangtiancheng/yukino-code/apps/mcp-go/internal/tools/operations"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

const description = "Execute arbitrary MySQL SQL with full connection privileges: queries, writes, DDL, transactions, administration and multiple statements. Put a complete transaction in one call. Optional ? parameters are supported. Returns query rows or mutation result headers and field metadata for all statements. Uses MYSQL_URL or connection_url."

func Module() tools.ToolModule {
	return tools.ToolModule{Name: "mysql", Register: func(server *mcp.Server) {
		tools.AddTool(server, &mcp.Tool{Name: tools.MySQLTool, Title: "MySQL", Description: description}, handle)
	}}
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
	cfg, err := mysqldriver.ParseDSN(dsn)
	if err != nil {
		return operations.ResultErr(tools.MySQLTool, err), nil, nil
	}
	data, err := query(ctx, cfg, in.SQL, in.Params)
	if err != nil {
		return operations.ResultErr(tools.MySQLTool, err), nil, nil
	}
	return operations.Result(data), nil, nil
}

func query(ctx context.Context, cfg *mysqldriver.Config, sql string, params []any) (map[string]any, error) {
	timeout := cfg.Timeout
	if timeout == 0 {
		timeout = 10 * time.Second
	}
	connectCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	var socket net.Conn
	dialer := net.Dialer{Timeout: timeout}
	dial := func(ctx context.Context, network, address string) (net.Conn, error) {
		var err error
		socket, err = dialer.DialContext(ctx, network, address)
		if err == nil {
			if deadline, ok := ctx.Deadline(); ok {
				_ = socket.SetDeadline(deadline)
			}
		}
		return socket, err
	}
	conn, err := client.ConnectWithDialer(connectCtx, cfg.Net, cfg.Addr, cfg.User, cfg.Passwd, cfg.DBName, dial, func(conn *client.Conn) error {
		conn.ReadTimeout = cfg.ReadTimeout
		conn.WriteTimeout = cfg.WriteTimeout
		if cfg.TLS != nil {
			conn.SetTLSConfig(cfg.TLS.Clone())
		}
		for _, flag := range []uint32{wire.CLIENT_MULTI_STATEMENTS, wire.CLIENT_MULTI_RESULTS, wire.CLIENT_FOUND_ROWS, wire.CLIENT_SESSION_TRACK} {
			if err := conn.SetCapability(flag); err != nil {
				return err
			}
		}
		collation := cfg.Collation
		if collation == "" {
			collation = "utf8mb4_unicode_ci"
		}
		return conn.SetCollation(collation)
	})
	if err != nil {
		return nil, err
	}
	defer conn.Close()
	_ = socket.SetDeadline(time.Time{})
	stop := context.AfterFunc(ctx, func() { _ = socket.Close() })
	defer stop()
	for _, key := range operations.SortedKeys(cfg.Params) {
		value := cfg.Params[key]
		if key == "charset" {
			if err := conn.SetCharset(strings.Split(value, ",")[0]); err != nil {
				return nil, err
			}
		} else {
			result, err := conn.Execute("SET " + escapeID(key) + "=" + value)
			if err != nil {
				return nil, err
			}
			result.Close()
		}
	}
	var results, fields []any
	var resultErr error
	final, err := conn.ExecuteMultiple(formatSQL(sql, params), func(result *wire.Result, err error) {
		if err != nil {
			resultErr = err
			return
		}
		defer result.Close()
		rows, columns, err := normalizeResult(result, cfg.Loc)
		if err != nil {
			resultErr = err
			return
		}
		results = append(results, rows)
		fields = append(fields, columns)
	})
	if final != nil {
		final.Close()
	}
	if err != nil {
		return nil, err
	}
	if resultErr != nil {
		return nil, resultErr
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if len(results) == 1 {
		data := map[string]any{"results": results[0]}
		if fields[0] != nil {
			data["fields"] = fields[0]
		}
		return data, nil
	}
	return map[string]any{"results": results, "fields": fields}, nil
}

var changedRowsPattern = regexp.MustCompile(`Changed:\s*(\d+)`)

func normalizeResult(result *wire.Result, location *time.Location) (any, any, error) {
	if !result.HasResultset() {
		changed := uint64(0)
		if match := changedRowsPattern.FindStringSubmatch(result.StatusMessage); match != nil {
			changed, _ = strconv.ParseUint(match[1], 10, 64)
		}
		return map[string]any{"fieldCount": 0, "affectedRows": safeInteger(result.AffectedRows), "insertId": safeInteger(result.InsertId), "info": result.StatusMessage, "serverStatus": result.Status, "warningStatus": result.Warnings, "changedRows": changed}, nil, nil
	}
	fields := make([]any, 0, len(result.Fields))
	for _, field := range result.Fields {
		fields = append(fields, map[string]any{"catalog": "def", "schema": string(field.Schema), "name": string(field.Name), "orgName": string(field.OrgName), "table": string(field.Table), "orgTable": string(field.OrgTable), "characterSet": field.Charset, "columnLength": field.ColumnLength, "type": field.Type, "flags": field.Flag, "decimals": field.Decimal})
	}
	rows := make([]any, 0, len(result.RowDatas))
	for _, data := range result.RowDatas {
		row := make(map[string]any, len(result.Fields))
		for _, field := range result.Fields {
			raw, null, read, err := wire.LengthEncodedString(data)
			if err != nil {
				return nil, nil, err
			}
			data = data[read:]
			var value any
			if !null {
				value, err = normalizeField(raw, field, location)
				if err != nil {
					return nil, nil, err
				}
			}
			row[string(field.Name)] = value
		}
		rows = append(rows, row)
	}
	return rows, fields, nil
}

func safeInteger(value uint64) any {
	if value > 9007199254740991 {
		return strconv.FormatUint(value, 10)
	}
	return value
}

func normalizeField(raw []byte, field *wire.Field, location *time.Location) (any, error) {
	text := string(raw)
	switch field.Type {
	case wire.MYSQL_TYPE_TINY, wire.MYSQL_TYPE_SHORT, wire.MYSQL_TYPE_LONG, wire.MYSQL_TYPE_INT24, wire.MYSQL_TYPE_YEAR, wire.MYSQL_TYPE_FLOAT, wire.MYSQL_TYPE_DOUBLE:
		return strconv.ParseFloat(text, 64)
	case wire.MYSQL_TYPE_LONGLONG, wire.MYSQL_TYPE_DECIMAL, wire.MYSQL_TYPE_NEWDECIMAL, wire.MYSQL_TYPE_TIME:
		return text, nil
	case wire.MYSQL_TYPE_JSON:
		var value any
		decoder := json.NewDecoder(bytes.NewReader(raw))
		decoder.UseNumber()
		if err := decoder.Decode(&value); err != nil {
			return nil, err
		}
		return normalizeJSONNumbers(value), nil
	case wire.MYSQL_TYPE_DATE, wire.MYSQL_TYPE_DATETIME, wire.MYSQL_TYPE_TIMESTAMP:
		if location == nil {
			location = time.Local
		}
		if field.Type == wire.MYSQL_TYPE_DATE {
			if len(text) != 10 {
				return nil, nil
			}
			year, e1 := strconv.Atoi(text[:4])
			month, e2 := strconv.Atoi(text[5:7])
			day, e3 := strconv.Atoi(text[8:])
			if e1 != nil || e2 != nil || e3 != nil {
				return nil, nil
			}
			// mysql2 constructs DATE values through new Date(y, m-1, d),
			// which normalizes zero dates and maps years 0..99 to 1900..1999.
			if year < 100 {
				year += 1900
			}
			return time.Date(year, time.Month(month), day, 0, 0, 0, 0, location).UTC().Format("2006-01-02T15:04:05.000Z"), nil
		}
		value, err := time.ParseInLocation("2006-01-02 15:04:05.999999", text, location)
		if err != nil {
			return nil, nil
		} // mysql2 serializes invalid/zero DATETIME/TIMESTAMP values as null.
		return value.UTC().Format("2006-01-02T15:04:05.000Z"), nil
	}
	if field.Charset == 63 {
		data := make([]int, len(raw))
		for i, b := range raw {
			data[i] = int(b)
		}
		return map[string]any{"type": "Buffer", "data": data}, nil
	}
	return text, nil
}

// mysql2's supportBigNumbers preserves unsafe integer JSON lexemes as strings,
// while decimal and exponent notation keep ordinary JavaScript numbers.
func normalizeJSONNumbers(value any) any {
	switch v := value.(type) {
	case json.Number:
		f, _ := v.Float64()
		if !strings.ContainsAny(v.String(), ".eE") && math.Abs(f) > 9007199254740991 {
			return v.String()
		}
		if math.IsInf(f, 0) {
			return nil
		}
		return f
	case []any:
		for i, entry := range v {
			v[i] = normalizeJSONNumbers(entry)
		}
	case map[string]any:
		for key, entry := range v {
			v[key] = normalizeJSONNumbers(entry)
		}
	}
	return value
}

// toDSN converts a mysql:// URL or normalizes an existing go-sql-driver DSN,
// enabling multi-statement batches and parameter interpolation.
func toDSN(raw string) (string, error) {
	if !strings.Contains(raw, "://") {
		cfg, err := mysqldriver.ParseDSN(raw)
		if err != nil {
			return "", err
		}
		cfg.MultiStatements = true
		cfg.InterpolateParams = true
		return cfg.FormatDSN(), nil
	}
	u, err := url.Parse(raw)
	if err != nil {
		return "", err
	}
	if u.Scheme != "mysql" {
		return "", fmt.Errorf("unsupported MySQL URL scheme %q", u.Scheme)
	}
	cfg := mysqldriver.NewConfig()
	cfg.Net = "tcp"
	cfg.Addr = u.Host
	if u.Port() == "" {
		cfg.Addr = net.JoinHostPort(u.Hostname(), "3306")
	}
	if u.User != nil {
		cfg.User = u.User.Username()
		if password, ok := u.User.Password(); ok {
			cfg.Passwd = password
		}
	}
	cfg.DBName = strings.TrimPrefix(u.Path, "/")
	cfg.MultiStatements = true
	cfg.ParseTime = true
	// Parse the URL options through the driver's DSN parser so TLS, timeouts,
	// charset and session settings are retained instead of silently discarded.
	if u.RawQuery != "" {
		cfg, err = mysqldriver.ParseDSN(cfg.FormatDSN() + "&" + u.RawQuery)
		if err != nil {
			return "", err
		}
	}
	cfg.MultiStatements = true
	// Parameters in multi-statement batches require client-side interpolation.
	cfg.InterpolateParams = true
	return cfg.FormatDSN(), nil
}

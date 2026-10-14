package mysql

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"strings"
	"testing"
	"time"

	wire "github.com/go-mysql-org/go-mysql/mysql"
	"github.com/go-mysql-org/go-mysql/server"
	mysqldriver "github.com/go-sql-driver/mysql"
)

type batchHandler struct {
	server.EmptyHandler
	conn    *server.Conn
	queries chan string
}

func (h *batchHandler) UseDB(string) error { return nil }

func (h *batchHandler) HandleQuery(sql string) (*wire.Result, error) {
	if strings.HasPrefix(sql, "SET ") {
		return &wire.Result{}, nil
	}
	h.queries <- sql
	if !strings.Contains(sql, ";") {
		return &wire.Result{AffectedRows: 1, InsertId: 7}, nil
	}
	h.conn.SetStatus(wire.SERVER_MORE_RESULTS_EXISTS | wire.SERVER_STATUS_AUTOCOMMIT)
	if err := h.conn.WriteValue(&wire.Result{AffectedRows: 1, InsertId: 9007199254740993}); err != nil {
		return nil, err
	}
	rows, err := wire.BuildSimpleTextResultset([]string{"text", "integer", "big", "decimal", "binary", "json", "date", "nullable"}, [][]any{{"00123", "42", "9223372036854775807", "12.50", []byte{0, 255}, `{"ok":true}`, "2026-01-02", nil}})
	if err != nil {
		return nil, err
	}
	types := []byte{wire.MYSQL_TYPE_VAR_STRING, wire.MYSQL_TYPE_LONG, wire.MYSQL_TYPE_LONGLONG, wire.MYSQL_TYPE_NEWDECIMAL, wire.MYSQL_TYPE_BLOB, wire.MYSQL_TYPE_JSON, wire.MYSQL_TYPE_DATE, wire.MYSQL_TYPE_VAR_STRING}
	for i, field := range rows.Fields {
		field.Type = types[i]
		field.Charset = 45
	}
	rows.Fields[4].Charset = 63
	if err := h.conn.WriteValue(wire.NewResult(rows)); err != nil {
		return nil, err
	}
	h.conn.UnsetStatus(wire.SERVER_MORE_RESULTS_EXISTS)
	return &wire.Result{AffectedRows: 2, Warnings: 1, StatusMessage: "Rows matched: 2  Changed: 1  Warnings: 1"}, nil
}

func mysqlFixture(t *testing.T) (*mysqldriver.Config, <-chan string) {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	queries := make(chan string, 10)
	finished := make(chan struct{})
	go func() {
		defer close(finished)
		backend := server.NewServer("8.0.11", 45, wire.AUTH_NATIVE_PASSWORD, nil, nil)
		for {
			socket, err := listener.Accept()
			if err != nil {
				return
			}
			_ = socket.SetDeadline(time.Now().Add(10 * time.Second))
			h := &batchHandler{queries: queries}
			auth := server.NewInMemoryAuthenticationHandler()
			_ = auth.AddUser("user", "pass", wire.AUTH_NATIVE_PASSWORD)
			conn, err := backend.NewCustomizedConn(socket, auth, h)
			if err != nil {
				_ = socket.Close()
				continue
			}
			h.conn = conn
			for conn.HandleCommand() == nil {
			}
			_ = socket.Close()
		}
	}()
	t.Cleanup(func() { _ = listener.Close(); <-finished })
	cfg, err := mysqldriver.ParseDSN(fmt.Sprintf("user:pass@tcp(%s)/db", listener.Addr()))
	if err != nil {
		t.Fatal(err)
	}
	return cfg, queries
}

func TestProtocolRetainsEveryStatementAndNativeTypes(t *testing.T) {
	cfg, queries := mysqlFixture(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	data, err := query(ctx, cfg, "INSERT INTO test VALUES (?); SELECT * FROM test; UPDATE test SET value=1", []any{"a'; DROP TABLE test; --"})
	if err != nil {
		t.Fatal(err)
	}
	if got := <-queries; got != "INSERT INTO test VALUES ('a\\'; DROP TABLE test; --'); SELECT * FROM test; UPDATE test SET value=1" {
		t.Fatalf("query changed: %q", got)
	}
	results := data["results"].([]any)
	fields := data["fields"].([]any)
	if len(results) != 3 || len(fields) != 3 || fields[0] != nil || fields[2] != nil {
		t.Fatalf("batch lost statements: %#v", data)
	}
	first, last := results[0].(map[string]any), results[2].(map[string]any)
	if first["insertId"] != "9007199254740993" || last["changedRows"] != uint64(1) || last["warningStatus"] != uint16(1) || last["info"] == "" {
		t.Fatalf("mutation headers: %#v", results)
	}
	row := results[1].([]any)[0].(map[string]any)
	if row["text"] != "00123" || row["integer"] != float64(42) || row["big"] != "9223372036854775807" || row["decimal"] != "12.50" || row["date"] != "2026-01-02T00:00:00.000Z" || row["nullable"] != nil {
		t.Fatalf("row types: %#v", row)
	}
	encoded, _ := json.Marshal(row["binary"])
	if string(encoded) != `{"data":[0,255],"type":"Buffer"}` {
		t.Fatalf("binary: %s", encoded)
	}
	if row["json"].(map[string]any)["ok"] != true {
		t.Fatalf("JSON: %#v", row)
	}
	single, err := query(ctx, cfg, "INSERT INTO test VALUES (1)", nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := single["fields"]; ok {
		t.Fatalf("mutation has query fields: %#v", single)
	}
}

func TestTextParametersMatchMySQL2(t *testing.T) {
	got := formatSQL("SELECT ?? WHERE id IN (?) AND flag=?; INSERT INTO t VALUES ?; UPDATE t SET ?", []any{"db.na`me", []any{float64(1), "two", nil}, true, []any{[]any{float64(1), "a"}, []any{float64(2), "b"}}, map[string]any{"x": "\x00\n'\\"}})
	want := "SELECT `db`.`na``me` WHERE id IN (1, 'two', NULL) AND flag=true; INSERT INTO t VALUES (1, 'a'), (2, 'b'); UPDATE t SET `x` = '\\0\\n\\'\\\\'"
	if got != want {
		t.Fatalf("got %q\nwant %q", got, want)
	}
	if got := formatSQL("SELECT ???, ?, ?", []any{float64(1)}); got != "SELECT ???, 1, ?" {
		t.Fatalf("placeholder handling: %s", got)
	}
}

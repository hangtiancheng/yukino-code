package postgres

import (
	"context"
	"encoding/json"
	"net"
	"reflect"
	"testing"
	"time"

	"github.com/hangtiancheng/yukino-code/apps/mcp-go/internal/tools/operations"
	"github.com/jackc/pgx/v5/pgproto3"
)

func postgresFixture(t *testing.T) (string, <-chan [][]byte) {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	bound := make(chan [][]byte, 2)
	finished := make(chan struct{})
	go func() {
		defer close(finished)
		for {
			socket, err := listener.Accept()
			if err != nil {
				return
			}
			_ = socket.SetDeadline(time.Now().Add(5 * time.Second))
			backend := pgproto3.NewBackend(socket, socket)
			if _, err := backend.ReceiveStartupMessage(); err != nil {
				_ = socket.Close()
				continue
			}
			backend.Send(&pgproto3.AuthenticationOk{})
			backend.Send(&pgproto3.ParameterStatus{Name: "server_version", Value: "16.0"})
			backend.Send(&pgproto3.ParameterStatus{Name: "client_encoding", Value: "UTF8"})
			backend.Send(&pgproto3.ReadyForQuery{TxStatus: 'I'})
			_ = backend.Flush()
			fields := []pgproto3.FieldDescription{{Name: []byte("integer"), DataTypeOID: 23, DataTypeSize: 4}, {Name: []byte("flag"), DataTypeOID: 16, DataTypeSize: 1}, {Name: []byte("big"), DataTypeOID: 20, DataTypeSize: 8}, {Name: []byte("decimal"), DataTypeOID: 1700, DataTypeSize: -1}, {Name: []byte("array"), DataTypeOID: 1007, DataTypeSize: -1}}
			row := &pgproto3.DataRow{Values: [][]byte{[]byte("42"), []byte("t"), []byte("9223372036854775807"), []byte("12.50"), []byte("{1,2,NULL}")}}
		commands:
			for {
				message, err := backend.Receive()
				if err != nil {
					break
				}
				switch m := message.(type) {
				case *pgproto3.Query:
					backend.Send(&pgproto3.CommandComplete{CommandTag: []byte("CREATE TABLE")})
					backend.Send(&pgproto3.RowDescription{Fields: fields})
					backend.Send(row)
					backend.Send(&pgproto3.CommandComplete{CommandTag: []byte("SELECT 1")})
					backend.Send(&pgproto3.CommandComplete{CommandTag: []byte("UPDATE 2")})
					backend.Send(&pgproto3.ReadyForQuery{TxStatus: 'I'})
				case *pgproto3.Parse:
					for _, oid := range m.ParameterOIDs {
						if oid != 0 {
							t.Errorf("parameter OID %d restricts server inference", oid)
						}
					}
					backend.Send(&pgproto3.ParseComplete{})
				case *pgproto3.Bind:
					for _, format := range m.ParameterFormatCodes {
						if format != 0 {
							t.Errorf("parameter encoded as binary")
						}
					}
					bound <- m.Parameters
					backend.Send(&pgproto3.BindComplete{})
				case *pgproto3.Describe:
					backend.Send(&pgproto3.RowDescription{Fields: fields})
				case *pgproto3.Execute:
					backend.Send(row)
					backend.Send(&pgproto3.CommandComplete{CommandTag: []byte("SELECT 1")})
				case *pgproto3.Sync:
					backend.Send(&pgproto3.ReadyForQuery{TxStatus: 'I'})
				case *pgproto3.Terminate:
					break commands
				}
				if backend.Flush() != nil {
					break
				}
			}
			_ = socket.Close()
		}
	}()
	t.Cleanup(func() { _ = listener.Close(); <-finished })
	return "postgres://user@" + listener.Addr().String() + "/db?sslmode=disable", bound
}

func TestPostgresProtocolParamsAndMultiStatementTypesAgree(t *testing.T) {
	url, bound := postgresFixture(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	call := func(in operations.SQLInput) []map[string]any {
		in.ConnectionURL = url
		res, _, err := handle(ctx, nil, in)
		if err != nil || res.IsError {
			t.Fatalf("query: %v %+v", err, res)
		}
		raw, _ := json.Marshal(res.StructuredContent)
		var result struct {
			Results []map[string]any `json:"results"`
		}
		if err := json.Unmarshal(raw, &result); err != nil {
			t.Fatal(err)
		}
		return result.Results
	}
	multi := call(operations.SQLInput{SQL: "CREATE TABLE test(id int); SELECT * FROM test; UPDATE test SET id=1"})
	if len(multi) != 3 || multi[0]["row_count"] != nil || multi[2]["row_count"] != float64(2) {
		t.Fatalf("statement results: %#v", multi)
	}
	single := call(operations.SQLInput{SQL: "SELECT $1::int,$2::bool,$3::int8,$4::numeric,$5::int[],$6::json,$7::text", Params: []any{float64(42), true, "9223372036854775807", "12.50", []any{float64(1), float64(2), nil}, map[string]any{"a": true}, nil}})
	if len(single) != 1 || !reflect.DeepEqual(single[0], multi[1]) {
		t.Fatalf("query types differ: %#v vs %#v", single, multi[1])
	}
	parameters := <-bound
	want := [][]byte{[]byte("42"), []byte("true"), []byte("9223372036854775807"), []byte("12.50"), []byte(`{"1","2",NULL}`), []byte(`{"a":true}`), nil}
	if !reflect.DeepEqual(parameters, want) {
		t.Fatalf("parameter values: %#v", parameters)
	}
}

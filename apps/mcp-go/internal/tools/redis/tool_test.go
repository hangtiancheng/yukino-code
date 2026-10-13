package redis

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"strconv"
	"strings"
	"testing"
)

// A RESP server keeps connection-local SELECT and MULTI state and returns nil
// bulk replies. This exercises the real go-redis client without a service.
func redisEndpoint(t *testing.T) string {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { listener.Close() })
	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			go func() {
				defer conn.Close()
				r := bufio.NewReader(conn)
				db := "0"
				transaction := false
				queued := 0
				for {
					line, err := r.ReadString('\n')
					if err != nil {
						return
					}
					n, err := strconv.Atoi(strings.TrimSpace(strings.TrimPrefix(line, "*")))
					if err != nil {
						return
					}
					args := make([]string, n)
					for i := range args {
						line, err := r.ReadString('\n')
						if err != nil {
							return
						}
						size, err := strconv.Atoi(strings.TrimSpace(strings.TrimPrefix(line, "$")))
						if err != nil || size < 0 {
							return
						}
						value := make([]byte, size+2)
						if _, err := io.ReadFull(r, value); err != nil {
							return
						}
						args[i] = string(value[:size])
					}
					if len(args) == 0 {
						return
					}
					var reply string
					switch strings.ToUpper(args[0]) {
					case "HELLO":
						reply = "-ERR unknown command 'hello'\r\n"
					case "CLIENT":
						reply = "+OK\r\n"
					case "PING":
						reply = "+PONG\r\n"
					case "SELECT":
						db, reply = args[1], "+OK\r\n"
					case "GET":
						if args[1] == "missing" {
							reply = "$-1\r\n"
						} else {
							reply = fmt.Sprintf("$%d\r\n%s\r\n", len(db), db)
						}
					case "MULTI":
						transaction, reply = true, "+OK\r\n"
					case "SET":
						if transaction {
							queued++
							reply = "+QUEUED\r\n"
						} else {
							reply = "+OK\r\n"
						}
					case "EXEC":
						reply = fmt.Sprintf("*%d\r\n", queued) + strings.Repeat("+OK\r\n", queued)
						transaction, queued = false, 0
					default:
						reply = "-ERR unknown command\r\n"
					}
					if _, err := io.WriteString(conn, reply); err != nil {
						return
					}
				}
			}()
		}
	}()
	return "redis://" + listener.Addr().String()
}

func TestBatchConnectionAndNilReplies(t *testing.T) {
	res, _, err := handle(context.Background(), nil, Input{
		ConnectionURL: redisEndpoint(t),
		Commands:      [][]string{{"SELECT", "2"}, {"GET", "db"}, {"GET", "missing"}, {"MULTI"}, {"SET", "key", "value"}, {"EXEC"}},
	})
	if err != nil || res.IsError {
		t.Fatalf("call failed: %v, %+v", err, res)
	}
	raw, err := json.Marshal(res.StructuredContent)
	if err != nil {
		t.Fatal(err)
	}
	if string(raw) != `{"results":["OK","2",null,"OK","QUEUED",["OK"]]}` {
		t.Fatalf("replies: %s", raw)
	}
}

func TestBatchStopsAtFirstError(t *testing.T) {
	res, _, err := handle(context.Background(), nil, Input{
		ConnectionURL: redisEndpoint(t), Commands: [][]string{{"PING"}, {"UNKNOWN"}, {"PING"}},
	})
	if err != nil || !res.IsError {
		t.Fatalf("error result: %v, %+v", err, res)
	}
	raw, _ := json.Marshal(res.StructuredContent)
	var data struct {
		Results []any `json:"results"`
		Failed  int   `json:"failed_command_index"`
	}
	if err := json.Unmarshal(raw, &data); err != nil {
		t.Fatal(err)
	}
	if data.Failed != 1 || len(data.Results) != 2 || data.Results[0] != "PONG" {
		t.Fatalf("invalid partial replies: %s", raw)
	}
}

// Copyright (c) 2026 hangtiancheng
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

// Package stdio runs the Yukino agent bridge (internal/bridge) as a child
// process speaking newline-delimited JSON-RPC 2.0 over stdin/stdout — the
// transport a terminal UI spawns when it wants the agent in-process to its
// own project directory.
//
// Framing: one JSON-RPC message per line. encoding/json never emits raw
// newlines, so a line is always exactly one message. A line past the size
// cap is discarded up to its newline and answered with a parse error (null
// id); the stream keeps serving the messages that follow. Stdout belongs to
// the protocol alone; all diagnostics go to stderr or to the yukino log
// files (the logger is initialized without stdout mirroring).
//
// Unlike the websocket deployment there is no chat pipeline: prompts arrive
// as session/prompt requests, finalized text is not filed into any transcript
// (the sink is a no-op — the client owns persistence), and the single session
// works directly in the process working directory with the standard yukino
// state under .yukino/. The session lives as long as the process: it is never
// idle-evicted, and closing stdin (or cancelling the context) shuts it down.
package stdio

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"sync"

	"github.com/hangtiancheng/yukino-code/yukino/bridge"
	"github.com/hangtiancheng/yukino-code/yukino/jsonrpc"
)

// maxLineLen mirrors the websocket transport's 4 MiB message cap.
const maxLineLen = 4 << 20

// userID is the synthetic identity of the local user. It only shows up in
// logs and sink calls (the sink is a no-op here).
const userID = "stdio"

// Run serves the bridge until stdin reaches EOF or ctx is cancelled. It
// returns a non-nil error only when the session could not be created (for
// example because yukino is not configured); a normal shutdown returns nil.
func Run(ctx context.Context, in io.Reader, out io.Writer) error {
	wd, err := os.Getwd()
	if err != nil {
		wd = "."
	}
	mgr := bridge.NewManager(noopSink{})
	sess, err := mgr.NewStandaloneSession(userID, wd)
	if err != nil {
		mgr.Stop()
		return err
	}
	conn := &lineConn{out: out}
	sess.Attach(conn)
	defer func() {
		sess.Cancel()
		sess.Detach(conn)
		sess.Close()
		mgr.Stop()
	}()

	// The reader runs on its own goroutine so the serve loop can also watch
	// the context: a signal must shut the bridge down even while stdin is
	// idle waiting for the next line.
	type inbound struct {
		line      []byte
		oversized bool
	}
	lines := make(chan inbound)
	go func() {
		defer close(lines)
		reader := bufio.NewReaderSize(in, 64*1024)
		for {
			line, oversized, err := readLine(reader, maxLineLen)
			if oversized || len(line) > 0 {
				select {
				case lines <- inbound{line: line, oversized: oversized}:
				case <-ctx.Done():
					return
				}
			}
			if err != nil {
				return
			}
		}
	}()

	for {
		select {
		case <-ctx.Done():
			return nil
		case msg, ok := <-lines:
			if !ok {
				// Stdin closed: the spawning client is gone, so is the bridge.
				return nil
			}
			if msg.oversized {
				// The id of a discarded line is unknowable, so the spec's
				// null-id parse error applies.
				conn.writeResponse(jsonrpc.Response{Err: jsonrpc.ParseError(
					fmt.Sprintf("message exceeds the %d byte line limit", maxLineLen))})
				continue
			}
			handleLine(sess, conn, msg.line)
		}
	}
}

// readLine reads one newline-terminated line, discarding everything past max
// content bytes and reporting it as oversized — bufio.Scanner stops
// permanently at that point, which would kill the whole bridge over one
// oversized client message. The cap counts the line content without its
// terminator (the old scanner semantics). The returned error is non-nil once
// the stream has ended after the line it delivered (EOF or a read failure);
// a final unterminated line is delivered before the EOF surfaces.
func readLine(reader *bufio.Reader, max int) (line []byte, oversized bool, err error) {
	for {
		var chunk []byte
		chunk, err = reader.ReadSlice('\n')
		// ReadSlice only returns a nil error when the delimiter was found,
		// and the chunk then ends with it.
		if err == nil {
			chunk = chunk[:len(chunk)-1]
		}
		if !oversized {
			if len(line)+len(chunk) > max {
				oversized = true
				line = nil
			} else {
				line = append(line, chunk...)
			}
		}
		if err == bufio.ErrBufferFull {
			continue // the line continues in the next read
		}
		if err != nil && len(line) == 0 && !oversized {
			return nil, false, err
		}
		// A completed line drops one \r before the terminator; the \r may sit
		// at the end of an earlier chunk, so this runs at delivery time. A
		// final unterminated remainder is delivered too — the next call
		// reports the EOF/read failure that ended the stream.
		return bytes.TrimSuffix(line, []byte("\r")), oversized, nil
	}
}

// handleLine answers one inbound JSON-RPC message. Requests get a response
// (result or protocol error); notifications are ignored — the protocol
// defines none from this side.
func handleLine(sess *bridge.Session, conn *lineConn, line []byte) {
	if len(bytes.TrimSpace(line)) == 0 {
		return
	}
	req, rpcErr := jsonrpc.Parse(line)
	if rpcErr != nil {
		var id jsonrpc.ID
		if req != nil {
			id = req.ID
		}
		conn.writeResponse(jsonrpc.Response{ID: id, Err: rpcErr})
		return
	}
	if req.IsNotification() {
		return
	}

	var result any
	if req.Method == bridge.MethodSessionPrompt {
		var p bridge.PromptParams
		if err := req.DecodeParams(&p); err != nil {
			rpcErr = jsonrpc.InvalidParams(err.Error())
		} else if p.Content == "" {
			rpcErr = jsonrpc.InvalidParams(`"content" is required`)
		} else {
			// queued=false means the turn queue is full; the session has
			// already told the client to slow down via agent/system.
			result = map[string]bool{"queued": sess.SubmitPrompt(p.Content)}
		}
	} else {
		result, rpcErr = sess.HandleControl(req)
	}
	conn.writeResponse(jsonrpc.Response{ID: req.ID, Result: result, Err: rpcErr})
}

// lineConn is the stdout side of the protocol: a bridge.Conn that frames
// every encoded message as one newline-terminated line. The mutex keeps
// concurrent writers (session worker, attach path, responses) from
// interleaving partial lines.
type lineConn struct {
	mu  sync.Mutex
	out io.Writer
}

func (c *lineConn) WriteMessage(data []byte) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	buf := make([]byte, 0, len(data)+1)
	buf = append(buf, data...)
	buf = append(buf, '\n')
	_, err := c.out.Write(buf)
	return err
}

func (c *lineConn) writeResponse(resp jsonrpc.Response) {
	data, err := json.Marshal(resp)
	if err != nil {
		return
	}
	_ = c.WriteMessage(data)
}

// noopSink drops finalized text: a stdio client receives it through
// agent/stream_text and agent/stream_end and owns whatever persistence it
// wants. The empty return keeps the stream anchor on the streamed bubble.
type noopSink struct{}

func (noopSink) SaveAssistantText(_, _, _ string) string { return "" }

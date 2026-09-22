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

// Package server exposes the Yukino agent bridge (yukino/bridge) over
// Connect (protobuf RPC) — the third transport next to the websocket and
// stdio ones, and the one the terminal UI's TypeScript client speaks.
//
// The mapping is deliberately thin and behavior-preserving:
//
//   - Downstream: every bridge notification fanned out to an attached
//     bridge.Conn becomes one Event on the Watch stream. Payload field names
//     in the contract mirror the bridge's JSON keys, so translation is a
//     protojson unmarshal per method plus a oneof wrap.
//   - Upstream: the unary RPCs call bridge.Session.SubmitPrompt and
//     bridge.Session.HandleControl — the exact control surface the stdio
//     transport exposes — so prompt queueing, permission/question resolution
//     (including the applied=false late-reply outcome) and cancel semantics
//     are identical across transports.
//
// Attaching a Watch stream replays session state and any prompt still
// waiting on an answer (bridge.Session.Attach), which is what makes a UI
// reconnect see the dialog it owes a response to.
package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"strings"
	"sync/atomic"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/encoding/protojson"

	"github.com/hangtiancheng/yukino-code/yukino/bridge"
	"github.com/hangtiancheng/yukino-code/yukino/jsonrpc"
	yukinov1 "github.com/hangtiancheng/yukino-code/yukino/pb/gen/yukino/v1"
	"github.com/hangtiancheng/yukino-code/yukino/pb/gen/yukino/v1/yukinov1connect"
)

// AgentService implements the generated AgentServiceHandler over one bridge
// session. One Server serves one user's session (the standalone deployment);
// concurrent Watch calls are independent attachments of that same session.
type AgentService struct {
	sess *bridge.Session

	// DiscardUnknown keeps the transport working when a newer bridge adds a
	// params field the contract does not carry yet.
	unmarshaler protojson.UnmarshalOptions
}

// NewAgentService wraps a bridge session as a Connect AgentService handler.
func NewAgentService(sess *bridge.Session) *AgentService {
	return &AgentService{
		sess:        sess,
		unmarshaler: protojson.UnmarshalOptions{DiscardUnknown: true},
	}
}

var _ yukinov1connect.AgentServiceHandler = (*AgentService)(nil)

// eventBufferSize smooths bursts (a fast stream_text run) between the bridge
// worker goroutine and the RPC stream. When it fills, WriteMessage blocks —
// the same backpressure the websocket transport applies — until the pump
// drains it or the stream ends.
const eventBufferSize = 256

var errConnClosed = errors.New("watch stream closed")

// watchConn is the bridge.Conn side of one Watch stream: notifications land
// as encoded JSON-RPC envelopes and are queued for the pump that translates
// and sends them.
type watchConn struct {
	events chan []byte
	done   chan struct{}
	closed atomic.Bool
}

func newWatchConn() *watchConn {
	return &watchConn{
		events: make(chan []byte, eventBufferSize),
		done:   make(chan struct{}),
	}
}

// WriteMessage queues one encoded notification. It blocks while the buffer is
// full and unblocks with an error once the stream has ended, so a dead client
// never stalls the agent worker.
func (c *watchConn) WriteMessage(data []byte) error {
	cp := make([]byte, len(data))
	copy(cp, data)
	select {
	case c.events <- cp:
		return nil
	case <-c.done:
		return errConnClosed
	}
}

// close releases writers blocked in WriteMessage. Called exactly once, from
// the Watch pump's defer.
func (c *watchConn) close() {
	if c.closed.CompareAndSwap(false, true) {
		close(c.done)
	}
}

// Watch attaches the caller to the session and streams events until the call
// is cancelled or the server shuts down.
func (s *AgentService) Watch(
	ctx context.Context,
	_ *connect.Request[yukinov1.WatchRequest],
	stream *connect.ServerStream[yukinov1.Event],
) error {
	conn := newWatchConn()
	s.sess.Attach(conn)
	defer func() {
		conn.close()
		s.sess.Detach(conn)
	}()

	for {
		select {
		case <-ctx.Done():
			return nil
		case data := <-conn.events:
			ev, err := s.translate(data)
			if err != nil {
				// A malformed or unmappable notification must not kill the
				// stream; the bridge already logged its own side.
				log.Printf("pbserver: dropping event: %v", err)
				continue
			}
			if ev == nil {
				// Unknown method: ignore, same as a client that does not
				// implement it yet.
				continue
			}
			if err := stream.Send(ev); err != nil {
				return err
			}
		}
	}
}

// translate parses one encoded JSON-RPC notification envelope and converts
// its payload into an Event. A nil Event with a nil error means "method not
// part of this contract".
func (s *AgentService) translate(data []byte) (*yukinov1.Event, error) {
	var env struct {
		Method string          `json:"method"`
		Params json.RawMessage `json:"params"`
	}
	if err := json.Unmarshal(data, &env); err != nil {
		return nil, fmt.Errorf("decode notification envelope: %w", err)
	}
	return s.translateNotification(env.Method, env.Params)
}

func (s *AgentService) translateNotification(method string, params json.RawMessage) (*yukinov1.Event, error) {
	ev := &yukinov1.Event{}
	switch method {
	case bridge.MethodSessionConnected:
		m := &yukinov1.SessionConnected{}
		if err := s.unmarshaler.Unmarshal(params, m); err != nil {
			return nil, err
		}
		ev.Event = &yukinov1.Event_SessionConnected{SessionConnected: m}

	case bridge.MethodSessionReady:
		ev.Event = &yukinov1.Event_SessionReady{SessionReady: &yukinov1.SessionReady{}}

	case bridge.MethodSessionCommands:
		// params is a bare array, the one shape protojson cannot take.
		var cmds []bridge.CommandInfo
		if len(params) > 0 {
			if err := json.Unmarshal(params, &cmds); err != nil {
				return nil, err
			}
		}
		m := &yukinov1.SessionCommands{Commands: make([]*yukinov1.CommandInfo, 0, len(cmds))}
		for _, c := range cmds {
			m.Commands = append(m.Commands, &yukinov1.CommandInfo{
				Name:        c.Name,
				Description: c.Description,
			})
		}
		ev.Event = &yukinov1.Event_SessionCommands{SessionCommands: m}

	case bridge.MethodSessionContextCleared:
		ev.Event = &yukinov1.Event_ContextCleared{ContextCleared: &yukinov1.ContextCleared{}}

	case bridge.MethodSessionCommandDone:
		ev.Event = &yukinov1.Event_CommandDone{CommandDone: &yukinov1.CommandDone{}}

	case bridge.MethodAgentRunStart:
		m := &yukinov1.RunStart{}
		if err := s.unmarshaler.Unmarshal(params, m); err != nil {
			return nil, err
		}
		ev.Event = &yukinov1.Event_RunStart{RunStart: m}

	case bridge.MethodAgentStreamText:
		m := &yukinov1.StreamText{}
		if err := s.unmarshaler.Unmarshal(params, m); err != nil {
			return nil, err
		}
		ev.Event = &yukinov1.Event_StreamText{StreamText: m}

	case bridge.MethodAgentStreamEnd:
		m := &yukinov1.StreamEnd{}
		if err := s.unmarshaler.Unmarshal(params, m); err != nil {
			return nil, err
		}
		ev.Event = &yukinov1.Event_StreamEnd{StreamEnd: m}

	case bridge.MethodAgentThinkingText:
		m := &yukinov1.ThinkingText{}
		if err := s.unmarshaler.Unmarshal(params, m); err != nil {
			return nil, err
		}
		ev.Event = &yukinov1.Event_ThinkingText{ThinkingText: m}

	case bridge.MethodAgentThinkingComplete:
		m := &yukinov1.ThinkingComplete{}
		if err := s.unmarshaler.Unmarshal(params, m); err != nil {
			return nil, err
		}
		ev.Event = &yukinov1.Event_ThinkingComplete{ThinkingComplete: m}

	case bridge.MethodAgentToolUse:
		m := &yukinov1.ToolUse{}
		if err := s.unmarshaler.Unmarshal(params, m); err != nil {
			return nil, err
		}
		ev.Event = &yukinov1.Event_ToolUse{ToolUse: m}

	case bridge.MethodAgentToolResult:
		m := &yukinov1.ToolResult{}
		if err := s.unmarshaler.Unmarshal(params, m); err != nil {
			return nil, err
		}
		ev.Event = &yukinov1.Event_ToolResult{ToolResult: m}

	case bridge.MethodAgentTurnComplete:
		m := &yukinov1.TurnComplete{}
		if err := s.unmarshaler.Unmarshal(params, m); err != nil {
			return nil, err
		}
		ev.Event = &yukinov1.Event_TurnComplete{TurnComplete: m}

	case bridge.MethodAgentLoopComplete:
		m := &yukinov1.LoopComplete{}
		if err := s.unmarshaler.Unmarshal(params, m); err != nil {
			return nil, err
		}
		ev.Event = &yukinov1.Event_LoopComplete{LoopComplete: m}

	case bridge.MethodAgentUsage:
		m := &yukinov1.Usage{}
		if err := s.unmarshaler.Unmarshal(params, m); err != nil {
			return nil, err
		}
		ev.Event = &yukinov1.Event_Usage{Usage: m}

	case bridge.MethodAgentSystem:
		m := &yukinov1.SystemMessage{}
		if err := s.unmarshaler.Unmarshal(params, m); err != nil {
			return nil, err
		}
		ev.Event = &yukinov1.Event_System{System: m}

	case bridge.MethodAgentError:
		m := &yukinov1.AgentError{}
		if err := s.unmarshaler.Unmarshal(params, m); err != nil {
			return nil, err
		}
		ev.Event = &yukinov1.Event_Error{Error: m}

	case bridge.MethodAgentCompact:
		m := &yukinov1.Compact{}
		if err := s.unmarshaler.Unmarshal(params, m); err != nil {
			return nil, err
		}
		ev.Event = &yukinov1.Event_Compact{Compact: m}

	case bridge.MethodAgentRetry:
		m := &yukinov1.Retry{}
		if err := s.unmarshaler.Unmarshal(params, m); err != nil {
			return nil, err
		}
		ev.Event = &yukinov1.Event_Retry{Retry: m}

	case bridge.MethodPermissionRequest:
		m := &yukinov1.PermissionRequest{}
		if err := s.unmarshaler.Unmarshal(params, m); err != nil {
			return nil, err
		}
		ev.Event = &yukinov1.Event_PermissionRequest{PermissionRequest: m}

	case bridge.MethodQuestionAsk:
		m := &yukinov1.QuestionAsk{}
		if err := s.unmarshaler.Unmarshal(params, m); err != nil {
			return nil, err
		}
		ev.Event = &yukinov1.Event_QuestionAsk{QuestionAsk: m}

	default:
		return nil, nil
	}
	return ev, nil
}

// SendPrompt queues one user turn. Slash commands are interpreted by the
// bridge worker; an empty prompt is a client bug.
func (s *AgentService) SendPrompt(
	ctx context.Context,
	req *connect.Request[yukinov1.SendPromptRequest],
) (*connect.Response[yukinov1.SendPromptResponse], error) {
	text, blocks, err := contentBlocksToGo(req.Msg.GetContent())
	if err != nil {
		return nil, connect.NewError(connect.CodeInvalidArgument, err)
	}
	if text == "" && len(blocks) == 0 {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New(`"content" is required`))
	}
	// Text-only turns take the plain path so the conversation stores string
	// content (nil ContentBlocks), preserving the exact pre-multimodal shape;
	// turns with images carry the full block list. Exactly one job is queued.
	var queued bool
	if len(blocks) > 0 {
		queued = s.sess.SubmitPromptBlocks(text, blocks)
	} else {
		queued = s.sess.SubmitPrompt(text)
	}
	return connect.NewResponse(&yukinov1.SendPromptResponse{Queued: queued}), nil
}

// contentBlocksToGo converts the request's content blocks into the display text
// plus the conversation content-block list ([]map[string]any) the agent's LLM
// clients consume. A text-only turn returns nil blocks so the caller uses the
// plain string path. The block maps mirror the TS conversation image shape:
// {"type":"image","source":{"type":"base64","media_type":...,"data":...}}.
func contentBlocksToGo(in []*yukinov1.ContentBlock) (string, []map[string]any, error) {
	var textParts []string
	blocks := make([]map[string]any, 0, len(in))
	hasImage := false
	for _, b := range in {
		switch v := b.GetBlock().(type) {
		case *yukinov1.ContentBlock_Text:
			textParts = append(textParts, v.Text)
			blocks = append(blocks, map[string]any{"type": "text", "text": v.Text})
		case *yukinov1.ContentBlock_Image:
			img, err := imageBlockToGo(v.Image)
			if err != nil {
				return "", nil, err
			}
			blocks = append(blocks, img)
			hasImage = true
		}
	}
	text := strings.Join(textParts, "")
	if !hasImage {
		return text, nil, nil
	}
	return text, blocks, nil
}

// imageBlockToGo converts one ImageBlock into the conversation's image block map.
func imageBlockToGo(img *yukinov1.ImageBlock) (map[string]any, error) {
	switch src := img.GetSource().(type) {
	case *yukinov1.ImageBlock_Base64:
		mediaType := src.Base64.GetMediaType()
		data := src.Base64.GetData()
		if mediaType == "" || data == "" {
			return nil, errors.New("image base64 source requires media_type and data")
		}
		return map[string]any{
			"type": "image",
			"source": map[string]any{
				"type":       "base64",
				"media_type": mediaType,
				"data":       data,
			},
		}, nil
	case *yukinov1.ImageBlock_Url:
		if src.Url == "" {
			return nil, errors.New("image url source requires a url")
		}
		return map[string]any{
			"type":   "image",
			"source": map[string]any{"type": "url", "url": src.Url},
		}, nil
	default:
		return nil, errors.New("image block requires a base64 or url source")
	}
}

// RespondPermission answers a pending permission prompt. applied=false is a
// normal outcome (the prompt was already settled by a cancel or an earlier
// answer), not an error — matching the JSON-RPC control surface.
func (s *AgentService) RespondPermission(
	ctx context.Context,
	req *connect.Request[yukinov1.RespondPermissionRequest],
) (*connect.Response[yukinov1.RespondPermissionResponse], error) {
	response := ""
	switch req.Msg.GetResponse() {
	case yukinov1.PermissionResponse_PERMISSION_RESPONSE_ALLOW:
		response = "allow"
	case yukinov1.PermissionResponse_PERMISSION_RESPONSE_ALLOW_ALWAYS:
		response = "allowAlways"
	case yukinov1.PermissionResponse_PERMISSION_RESPONSE_DENY:
		response = "deny"
	default:
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New(`"response" must be allow, deny or allow_always`))
	}
	params, err := json.Marshal(map[string]string{
		"id":       req.Msg.GetId(),
		"response": response,
	})
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, err)
	}
	result, rpcErr := s.sess.HandleControl(&jsonrpc.Request{
		Method: bridge.MethodPermissionRespond,
		Params: params,
	})
	if rpcErr != nil {
		return nil, connect.NewError(connect.CodeInvalidArgument, rpcErr)
	}
	return connect.NewResponse(&yukinov1.RespondPermissionResponse{
		Applied: appliedFrom(result),
	}), nil
}

// RespondQuestions answers a pending AskUserQuestion prompt.
func (s *AgentService) RespondQuestions(
	ctx context.Context,
	req *connect.Request[yukinov1.RespondQuestionsRequest],
) (*connect.Response[yukinov1.RespondQuestionsResponse], error) {
	params, err := json.Marshal(map[string]any{
		"id":      req.Msg.GetId(),
		"answers": req.Msg.GetAnswers(),
	})
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, err)
	}
	result, rpcErr := s.sess.HandleControl(&jsonrpc.Request{
		Method: bridge.MethodQuestionRespond,
		Params: params,
	})
	if rpcErr != nil {
		return nil, connect.NewError(connect.CodeInvalidArgument, rpcErr)
	}
	return connect.NewResponse(&yukinov1.RespondQuestionsResponse{
		Applied: appliedFrom(result),
	}), nil
}

// Cancel interrupts the running turn, if any. The run's end still arrives as
// a LoopComplete event on every open Watch stream.
func (s *AgentService) Cancel(
	ctx context.Context,
	_ *connect.Request[yukinov1.CancelRequest],
) (*connect.Response[yukinov1.CancelResponse], error) {
	if _, rpcErr := s.sess.HandleControl(&jsonrpc.Request{Method: bridge.MethodSessionCancel}); rpcErr != nil {
		return nil, connect.NewError(connect.CodeInternal, rpcErr)
	}
	return connect.NewResponse(&yukinov1.CancelResponse{}), nil
}

// Ping is a liveness check.
func (s *AgentService) Ping(
	ctx context.Context,
	_ *connect.Request[yukinov1.PingRequest],
) (*connect.Response[yukinov1.PingResponse], error) {
	if _, rpcErr := s.sess.HandleControl(&jsonrpc.Request{Method: bridge.MethodPing}); rpcErr != nil {
		return nil, connect.NewError(connect.CodeInternal, rpcErr)
	}
	return connect.NewResponse(&yukinov1.PingResponse{}), nil
}

// SelectProvider switches the session's active LLM provider by name. It fails
// with FailedPrecondition while a turn is running, and with NotFound for an
// unknown provider name.
func (s *AgentService) SelectProvider(
	ctx context.Context,
	req *connect.Request[yukinov1.SelectProviderRequest],
) (*connect.Response[yukinov1.SelectProviderResponse], error) {
	name := req.Msg.GetName()
	if name == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New(`"name" is required`))
	}
	model, protocol, contextWindow, maxOutput, err := s.sess.SwitchProvider(name)
	if err != nil {
		code := connect.CodeInternal
		switch {
		case strings.Contains(err.Error(), "not found"):
			code = connect.CodeNotFound
		case strings.Contains(err.Error(), "while a turn is running"):
			code = connect.CodeFailedPrecondition
		}
		return nil, connect.NewError(code, err)
	}
	return connect.NewResponse(&yukinov1.SelectProviderResponse{
		Model:           model,
		Protocol:        protocol,
		ContextWindow:   int32(contextWindow),
		MaxOutputTokens: int32(maxOutput),
	}), nil
}

// appliedFrom extracts the {"applied": bool} result both respond methods of
// the control surface return.
func appliedFrom(result any) bool {
	if m, ok := result.(map[string]bool); ok {
		return m["applied"]
	}
	return false
}

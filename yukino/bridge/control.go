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

package bridge

import (
	"github.com/hangtiancheng/yukino-code/yukino/jsonrpc"
)

// HandleControl routes one inbound JSON-RPC request to the session's control
// surface and returns the result to answer with (nil renders as {}). The
// transport wraps the pair in a response; client notifications never reach
// this function.
//
// Methods outside this control surface — notably session/prompt, which only
// the stdio transport exposes — are handled by the transport itself before
// falling through here.
func (s *Session) HandleControl(req *jsonrpc.Request) (any, *jsonrpc.Error) {
	switch req.Method {
	case MethodPermissionRespond:
		var p permissionRespondParams
		if err := req.DecodeParams(&p); err != nil {
			return nil, jsonrpc.InvalidParams(err.Error())
		}
		if p.ID == "" {
			return nil, jsonrpc.InvalidParams(`"id" is required`)
		}
		// applied=false is a normal outcome (a late reply to a prompt that a
		// cancel or an earlier answer already settled), not a protocol error.
		return map[string]bool{"applied": s.resolvePermission(p.ID, p.Response)}, nil

	case MethodQuestionRespond:
		var p questionRespondParams
		if err := req.DecodeParams(&p); err != nil {
			return nil, jsonrpc.InvalidParams(err.Error())
		}
		if p.ID == "" {
			return nil, jsonrpc.InvalidParams(`"id" is required`)
		}
		return map[string]bool{"applied": s.resolveAsk(p.ID, p.Answers)}, nil

	case MethodSessionCancel:
		s.Cancel()
		return nil, nil

	case MethodPing:
		return nil, nil

	default:
		return nil, jsonrpc.MethodNotFound(req.Method)
	}
}

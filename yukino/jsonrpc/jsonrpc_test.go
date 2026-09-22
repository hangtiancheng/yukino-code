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

package jsonrpc

import (
	"encoding/json"
	"testing"
)

func TestParseRequest(t *testing.T) {
	req, rpcErr := Parse([]byte(`{"jsonrpc":"2.0","id":7,"method":"ping","params":{"a":1}}`))
	if rpcErr != nil {
		t.Fatalf("unexpected error: %v", rpcErr)
	}
	if req.IsNotification() {
		t.Fatal("message with id 7 parsed as notification")
	}
	if req.Method != "ping" {
		t.Fatalf("method = %q", req.Method)
	}
	var params struct {
		A int `json:"a"`
	}
	if err := req.DecodeParams(&params); err != nil || params.A != 1 {
		t.Fatalf("DecodeParams = %+v, %v", params, err)
	}
}

func TestParseStringID(t *testing.T) {
	req, rpcErr := Parse([]byte(`{"jsonrpc":"2.0","id":"abc-1","method":"m"}`))
	if rpcErr != nil {
		t.Fatalf("unexpected error: %v", rpcErr)
	}
	if string(req.ID) != `"abc-1"` {
		t.Fatalf("id = %s", req.ID)
	}
	// The response must echo the id verbatim.
	data, err := json.Marshal(Response{ID: req.ID})
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != `{"jsonrpc":"2.0","id":"abc-1","result":{}}` {
		t.Fatalf("response = %s", data)
	}
}

func TestParseNotifications(t *testing.T) {
	for _, msg := range []string{
		`{"jsonrpc":"2.0","method":"n"}`,
		`{"jsonrpc":"2.0","id":null,"method":"n"}`,
	} {
		req, rpcErr := Parse([]byte(msg))
		if rpcErr != nil {
			t.Fatalf("%s: unexpected error: %v", msg, rpcErr)
		}
		if !req.IsNotification() {
			t.Fatalf("%s: not detected as notification", msg)
		}
		// DecodeParams on a params-less request must leave v untouched.
		var v struct{ X int }
		if err := req.DecodeParams(&v); err != nil {
			t.Fatalf("%s: DecodeParams: %v", msg, err)
		}
	}
}

func TestParseErrors(t *testing.T) {
	cases := []struct {
		msg  string
		code int
	}{
		{``, CodeParseError},
		{`{`, CodeParseError},
		{`[{"jsonrpc":"2.0","id":1,"method":"m"}]`, CodeInvalidRequest},
		{`{"jsonrpc":"1.0","id":1,"method":"m"}`, CodeInvalidRequest},
		{`{"jsonrpc":"2.0","id":1}`, CodeInvalidRequest},
		{`{"jsonrpc":"2.0","id":1,"method":""}`, CodeInvalidRequest},
		// A response is not a request.
		{`{"jsonrpc":"2.0","id":1,"result":{}}`, CodeInvalidRequest},
		// Well-formed JSON with member type violations is an invalid request,
		// NOT a parse error (the spec reserves -32700 for invalid JSON).
		{`{"jsonrpc":"2.0","id":1,"method":123}`, CodeInvalidRequest},
		{`{"jsonrpc":2.0,"id":1,"method":"m"}`, CodeInvalidRequest},
		{`{"jsonrpc":"2.0","id":true,"method":"m"}`, CodeInvalidRequest},
		// The id must be a string, number or null.
		{`{"jsonrpc":"2.0","id":{},"method":"m"}`, CodeInvalidRequest},
		{`{"jsonrpc":"2.0","id":[1],"method":"m"}`, CodeInvalidRequest},
		// params must be a structured value when present (null is tolerated
		// as absent).
		{`{"jsonrpc":"2.0","id":1,"method":"m","params":5}`, CodeInvalidRequest},
		{`{"jsonrpc":"2.0","id":1,"method":"m","params":"x"}`, CodeInvalidRequest},
	}
	for _, c := range cases {
		req, rpcErr := Parse([]byte(c.msg))
		if rpcErr == nil {
			t.Fatalf("%q: parsed without error as %+v", c.msg, req)
		}
		if rpcErr.Code != c.code {
			t.Fatalf("%q: code = %d, want %d", c.msg, rpcErr.Code, c.code)
		}
	}

	// An invalid request whose envelope decoded keeps the id for the echo.
	req, rpcErr := Parse([]byte(`{"jsonrpc":"1.0","id":42,"method":"m"}`))
	if rpcErr == nil || req == nil || string(req.ID) != "42" {
		t.Fatalf("id echo on invalid request: req=%+v err=%v", req, rpcErr)
	}
	// A parse error has no id to echo.
	if req, _ := Parse([]byte(`{`)); req != nil {
		t.Fatalf("parse error returned request %+v", req)
	}
	// An id whose type is itself invalid must NOT be echoed: the spec
	// requires a null id when the id cannot be determined.
	req, rpcErr = Parse([]byte(`{"jsonrpc":"2.0","id":{"a":1},"method":"m"}`))
	if rpcErr == nil || req == nil || len(req.ID) != 0 {
		t.Fatalf("invalid id echo: req=%+v err=%v", req, rpcErr)
	}
}

// An explicit params null is tolerated as absent, and string/number ids both
// parse.
func TestParseToleratesNullParams(t *testing.T) {
	req, rpcErr := Parse([]byte(`{"jsonrpc":"2.0","id":"x-1","method":"m","params":null}`))
	if rpcErr != nil {
		t.Fatalf("unexpected error: %v", rpcErr)
	}
	if len(req.Params) != 0 {
		t.Fatalf("null params should decode as absent, got %s", req.Params)
	}
	var v struct{ Y int }
	if err := req.DecodeParams(&v); err != nil {
		t.Fatalf("DecodeParams: %v", err)
	}
}

func TestResponseMarshal(t *testing.T) {
	// A nil result still renders as {} — a response needs result or error.
	data, err := json.Marshal(Response{ID: json.RawMessage(`3`)})
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != `{"jsonrpc":"2.0","id":3,"result":{}}` {
		t.Fatalf("nil result response = %s", data)
	}

	// An error response omits result.
	data, err = json.Marshal(Response{ID: json.RawMessage(`3`), Result: "ignored", Err: MethodNotFound("x")})
	if err != nil {
		t.Fatal(err)
	}
	var probe struct {
		Result *string `json:"result"`
		Error  *Error  `json:"error"`
	}
	if err := json.Unmarshal(data, &probe); err != nil {
		t.Fatal(err)
	}
	if probe.Result != nil || probe.Error == nil || probe.Error.Code != CodeMethodNotFound {
		t.Fatalf("error response = %s", data)
	}

	// A parse-error response carries a null id.
	data, err = json.Marshal(Response{Err: ParseError("bad")})
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != `{"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":"Parse error","data":"bad"}}` {
		t.Fatalf("parse error response = %s", data)
	}
}

func TestNotificationMarshal(t *testing.T) {
	data, err := json.Marshal(NewNotification("session/ready", nil))
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != `{"jsonrpc":"2.0","method":"session/ready"}` {
		t.Fatalf("nil params notification = %s", data)
	}
	data, err = json.Marshal(NewNotification("agent/usage", map[string]int{"inputTokens": 1}))
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != `{"jsonrpc":"2.0","method":"agent/usage","params":{"inputTokens":1}}` {
		t.Fatalf("params notification = %s", data)
	}
}

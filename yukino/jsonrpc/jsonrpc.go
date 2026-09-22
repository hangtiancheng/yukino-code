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

// Package jsonrpc implements the JSON-RPC 2.0 wire format: requests,
// notifications, responses and the standard error codes. It is deliberately
// transport-agnostic — framing (one websocket text message, one
// newline-delimited line) is up to the caller.
//
// Batch messages are not supported: a batch array is rejected as an invalid
// request. The bridge protocols never need batching, and rejecting it keeps
// the request/response correlation trivial.
package jsonrpc

import (
	"bytes"
	"encoding/json"
)

// Version is the JSON-RPC protocol version every message must carry.
const Version = "2.0"

// Standard JSON-RPC 2.0 error codes.
const (
	CodeParseError     = -32700
	CodeInvalidRequest = -32600
	CodeMethodNotFound = -32601
	CodeInvalidParams  = -32602
	CodeInternalError  = -32603
)

// ID is a request identifier (a JSON string or number). It is kept as raw
// JSON so a response can echo it back verbatim without the package having to
// pick a Go type for it.
type ID = json.RawMessage

// Request is one inbound message. A message without an id (or with a null
// id) is a notification and must not be answered.
type Request struct {
	JsonRPC string          `json:"jsonrpc"`
	ID      ID              `json:"id,omitempty"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params,omitempty"`
}

// IsNotification reports whether the message omits a request id.
func (r *Request) IsNotification() bool {
	return len(r.ID) == 0 || bytes.Equal(r.ID, []byte("null"))
}

// DecodeParams unmarshals the request params into v. A request without
// params decodes into the zero value of v.
func (r *Request) DecodeParams(v any) error {
	if len(r.Params) == 0 {
		return nil
	}
	return json.Unmarshal(r.Params, v)
}

// Error is a JSON-RPC 2.0 error object.
type Error struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
	Data    any    `json:"data,omitempty"`
}

func (e *Error) Error() string { return e.Message }

// NewError builds an error object with a custom (typically server-defined,
// in the -32000..-32099 range) code.
func NewError(code int, message string) *Error {
	return &Error{Code: code, Message: message}
}

// ParseError reports malformed JSON. The id is unknown at that point, so the
// response must carry a null id.
func ParseError(detail string) *Error {
	return &Error{Code: CodeParseError, Message: "Parse error", Data: detail}
}

// InvalidRequest reports a well-formed JSON document that is not a usable
// JSON-RPC 2.0 request (wrong version, missing method, a batch array, or a
// response where a request was expected).
func InvalidRequest(detail string) *Error {
	return &Error{Code: CodeInvalidRequest, Message: "Invalid Request", Data: detail}
}

// MethodNotFound reports an unknown method name.
func MethodNotFound(method string) *Error {
	return &Error{Code: CodeMethodNotFound, Message: "Method not found", Data: method}
}

// InvalidParams reports params that failed to decode or failed validation.
func InvalidParams(detail string) *Error {
	return &Error{Code: CodeInvalidParams, Message: "Invalid params", Data: detail}
}

// Parse decodes one JSON-RPC 2.0 request or notification. On failure it
// returns the protocol error to answer with. The two failure classes stay
// apart per the spec: -32700 is reserved for text that is not valid JSON at
// all, while a well-formed document whose members violate the Request object
// rules (wrong version, missing/non-string method, non string/number/null id,
// non-structured params) is an Invalid Request (-32600).
//
// When the document carries a spec-legal id it is echoed in the error
// response, so the returned request is non-nil for those cases; a parse
// error, a batch, or an id whose type is itself invalid leaves the id nil
// and must be answered with a null id.
func Parse(data []byte) (*Request, *Error) {
	trimmed := bytes.TrimSpace(data)
	if len(trimmed) == 0 {
		return nil, ParseError("empty message")
	}
	if trimmed[0] == '[' {
		return nil, InvalidRequest("batch messages are not supported")
	}
	// Every member decodes into RawMessage first: a concrete-typed field
	// would turn a member type violation (e.g. a numeric "method") into an
	// UnmarshalTypeError and mislabel it as a parse error.
	var envelope struct {
		JsonRPC json.RawMessage `json:"jsonrpc"`
		ID      json.RawMessage `json:"id"`
		Method  json.RawMessage `json:"method"`
		Params  json.RawMessage `json:"params"`
	}
	if err := json.Unmarshal(trimmed, &envelope); err != nil {
		return nil, ParseError(err.Error())
	}
	partial := &Request{}
	// An id the spec cannot carry (object/array/bool) is the invalid part
	// itself — the error response falls back to a null id rather than
	// echoing it.
	if len(envelope.ID) > 0 && !validID(envelope.ID) {
		return partial, InvalidRequest(`"id" must be a string, number or null`)
	}
	partial.ID = envelope.ID
	var version string
	if err := json.Unmarshal(envelope.JsonRPC, &version); err != nil || version != Version {
		return partial, InvalidRequest(`"jsonrpc" must be "2.0"`)
	}
	partial.JsonRPC = Version
	method, ok := jsonString(envelope.Method)
	if !ok || method == "" {
		return partial, InvalidRequest(`"method" must be a non-empty string`)
	}
	partial.Method = method
	// params, when present, must be a structured value; an explicit null is
	// tolerated as absent (universal client practice).
	if len(envelope.Params) > 0 && !bytes.Equal(envelope.Params, []byte("null")) {
		if envelope.Params[0] != '{' && envelope.Params[0] != '[' {
			return partial, InvalidRequest(`"params" must be an object or an array`)
		}
		partial.Params = envelope.Params
	}
	return partial, nil
}

// validID reports whether raw is a spec-legal request id: a JSON string, a
// JSON number or null. RawMessage is compacted by the decoder, so the first
// byte decides the type unambiguously.
func validID(raw json.RawMessage) bool {
	switch raw[0] {
	case '"', '-', '0', '1', '2', '3', '4', '5', '6', '7', '8', '9':
		return true
	default:
		return bytes.Equal(raw, []byte("null"))
	}
}

// jsonString decodes a raw JSON string token; ok is false for any other type
// (and for an absent member).
func jsonString(raw json.RawMessage) (string, bool) {
	if len(raw) == 0 || raw[0] != '"' {
		return "", false
	}
	var s string
	if err := json.Unmarshal(raw, &s); err != nil {
		return "", false
	}
	return s, true
}

// Response is one outbound answer to a request. Exactly one of Result and
// Err is meaningful: when Err is set it wins, otherwise Result (even nil)
// is serialized — a nil result becomes {}, since a response without either
// member is not valid JSON-RPC.
type Response struct {
	// ID echoes the request id; nil renders as null, which is what the spec
	// requires for errors that prevented id extraction.
	ID     ID
	Result any
	Err    *Error
}

// MarshalJSON renders the response with the mandatory "jsonrpc" member and
// the result/error exclusivity the spec demands.
func (r Response) MarshalJSON() ([]byte, error) {
	if r.Err != nil {
		return json.Marshal(struct {
			JsonRPC string `json:"jsonrpc"`
			ID      ID     `json:"id"`
			Error   *Error `json:"error"`
		}{Version, r.ID, r.Err})
	}
	result := r.Result
	if result == nil {
		result = struct{}{}
	}
	return json.Marshal(struct {
		JsonRPC string `json:"jsonrpc"`
		ID      ID     `json:"id"`
		Result  any    `json:"result"`
	}{Version, r.ID, result})
}

// Notification is one outbound message that expects no answer.
type Notification struct {
	JsonRPC string `json:"jsonrpc"`
	Method  string `json:"method"`
	// Params is omitted when nil; the spec allows a notification without
	// the member.
	Params any `json:"params,omitempty"`
}

// NewNotification builds an outbound notification.
func NewNotification(method string, params any) Notification {
	return Notification{JsonRPC: Version, Method: method, Params: params}
}

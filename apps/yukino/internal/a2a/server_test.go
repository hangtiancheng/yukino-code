package a2a

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/yukino-js/yukino/yukino/internal/agent"
)

func TestParseA2aAddress(t *testing.T) {
	host, port, err := ParseA2aAddress("")
	if err != nil || host != "127.0.0.1" || port != A2ADefaultPort {
		t.Errorf("default address = %q %d %v", host, port, err)
	}
	host, port, err = ParseA2aAddress("19890")
	if err != nil || host != "127.0.0.1" || port != 19890 {
		t.Errorf("bare port = %q %d %v", host, port, err)
	}
	host, port, err = ParseA2aAddress("0")
	if err != nil || port != 0 {
		t.Errorf("ephemeral = %q %d %v", host, port, err)
	}
	if _, _, err := ParseA2aAddress("0.0.0.0:18890"); err == nil || err.Error() != LoopbackRequiredError {
		t.Errorf("non-loopback err = %v", err)
	}
	if _, _, err := ParseA2aAddress("192.168.1.5:18890"); err == nil || err.Error() != LoopbackRequiredError {
		t.Errorf("LAN address err = %v", err)
	}
}

func startTestServer(t *testing.T, runtime *fakeRuntime) *ServerHandle {
	t.Helper()
	server, err := StartServer(StartServerOptions{
		Address: "127.0.0.1:0",
		RuntimeFactory: func(cwd, sessionID string) (Runtime, error) {
			return runtime, nil
		},
		Cwd: t.TempDir(),
	})
	if err != nil {
		t.Fatalf("start server: %v", err)
	}
	t.Cleanup(func() { _ = server.Close() })
	return server
}

func postJSON(t *testing.T, url string, headers map[string]string, body string) (*http.Response, []byte) {
	t.Helper()
	request, err := http.NewRequest("POST", url, strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	for key, value := range headers {
		request.Header.Set(key, value)
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	data, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	return response, data
}

func TestServerProtocolErrors(t *testing.T) {
	runtime := &fakeRuntime{sessionID: "sess-1", cwd: t.TempDir(), script: simpleScript(agent.LoopComplete{StopReason: "end_turn"})}
	server := startTestServer(t, runtime)
	rpcURL := server.URL

	t.Run("missing version", func(t *testing.T) {
		response, body := postJSON(t, rpcURL, map[string]string{"Content-Type": "application/json"}, `{"jsonrpc":"2.0","id":1,"method":"GetTask","params":{"id":"x"}}`)
		if response.StatusCode != 200 {
			t.Fatalf("status = %d", response.StatusCode)
		}
		var envelope map[string]any
		if err := json.Unmarshal(body, &envelope); err != nil {
			t.Fatal(err)
		}
		errObj := envelope["error"].(map[string]any)
		if errObj["code"].(float64) != -32009 || errObj["message"] != MissingVersionError {
			t.Fatalf("error = %v", errObj)
		}
		details := errObj["data"].([]any)[0].(map[string]any)
		if details["reason"] != "VERSION_NOT_SUPPORTED" || details["domain"] != "a2a-protocol.org" {
			t.Fatalf("details = %v", details)
		}
		if envelope["id"].(float64) != 1 {
			t.Errorf("id must echo the request id: %v", envelope["id"])
		}
	})

	t.Run("unsupported version", func(t *testing.T) {
		response, body := postJSON(t, rpcURL, map[string]string{"A2A-Version": "2.0"}, `{}`)
		if response.StatusCode != 200 || !strings.Contains(string(body), `Unsupported A2A-Version \"2.0\"`) {
			t.Fatalf("status = %d body = %s", response.StatusCode, body)
		}
	})

	t.Run("rest missing version", func(t *testing.T) {
		response, body := postJSON(t, server.URL+"v1/message:send", map[string]string{"Content-Type": "application/json"}, `{}`)
		if response.StatusCode != 400 {
			t.Fatalf("status = %d", response.StatusCode)
		}
		var envelope map[string]any
		if err := json.Unmarshal(body, &envelope); err != nil {
			t.Fatal(err)
		}
		errObj := envelope["error"].(map[string]any)
		if errObj["status"] != "FAILED_PRECONDITION" || errObj["code"].(float64) != 400 {
			t.Fatalf("error = %v", errObj)
		}
	})

	t.Run("unknown method", func(t *testing.T) {
		response, body := postJSON(t, rpcURL, map[string]string{"A2A-Version": "1.0"}, `{"jsonrpc":"2.0","id":2,"method":"FooBar","params":{}}`)
		if response.StatusCode != 200 {
			t.Fatalf("status = %d", response.StatusCode)
		}
		var envelope map[string]any
		if err := json.Unmarshal(body, &envelope); err != nil {
			t.Fatal(err)
		}
		errObj := envelope["error"].(map[string]any)
		if errObj["code"].(float64) != -32601 || errObj["message"] != UnknownMethodError("FooBar") {
			t.Fatalf("error = %v", errObj)
		}
	})

	t.Run("malformed json", func(t *testing.T) {
		response, body := postJSON(t, rpcURL, map[string]string{"A2A-Version": "1.0"}, `{invalid`)
		if response.StatusCode != 400 {
			t.Fatalf("status = %d", response.StatusCode)
		}
		var envelope map[string]any
		if err := json.Unmarshal(body, &envelope); err != nil {
			t.Fatal(err)
		}
		errObj := envelope["error"].(map[string]any)
		if errObj["code"].(float64) != -32700 || errObj["message"] != MalformedJSONError {
			t.Fatalf("error = %v", errObj)
		}
	})

	t.Run("body too large", func(t *testing.T) {
		large := `{"jsonrpc":"2.0","id":3,"method":"GetTask","params":{"id":"` + strings.Repeat("x", RequestBodyLimit) + `"}}`
		response, body := postJSON(t, rpcURL, map[string]string{"A2A-Version": "1.0"}, large)
		if response.StatusCode != 413 {
			t.Fatalf("status = %d", response.StatusCode)
		}
		var envelope map[string]any
		if err := json.Unmarshal(body, &envelope); err != nil {
			t.Fatal(err)
		}
		errObj := envelope["error"].(map[string]any)
		if errObj["message"] != RequestTooLargeError {
			t.Fatalf("error = %v", errObj)
		}
	})
}

func TestServerAgentCard(t *testing.T) {
	runtime := &fakeRuntime{sessionID: "sess-1", cwd: t.TempDir(), script: simpleScript(agent.LoopComplete{StopReason: "end_turn"})}
	server := startTestServer(t, runtime)
	response, err := http.Get(server.CardURL)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != 200 {
		t.Fatalf("status = %d", response.StatusCode)
	}
	var card map[string]any
	if err := json.NewDecoder(response.Body).Decode(&card); err != nil {
		t.Fatal(err)
	}
	if card["name"] != "yukino" {
		t.Errorf("name = %v", card["name"])
	}
	interfaces := card["supportedInterfaces"].([]any)
	if len(interfaces) != 2 {
		t.Fatalf("interfaces = %v", interfaces)
	}
	first := interfaces[0].(map[string]any)
	if first["url"] != server.URL || first["protocolBinding"] != "JSONRPC" || first["protocolVersion"] != "1.0" {
		t.Errorf("jsonrpc interface = %v", first)
	}
	second := interfaces[1].(map[string]any)
	if second["url"] != server.URL+"v1/" || second["protocolBinding"] != "HTTP+JSON" {
		t.Errorf("rest interface = %v", second)
	}
	capabilities := card["capabilities"].(map[string]any)
	if capabilities["streaming"] != true {
		t.Errorf("streaming = %v", capabilities["streaming"])
	}
	extensions := capabilities["extensions"].([]any)
	extension := extensions[0].(map[string]any)
	if extension["uri"] != PermissionExtensionURI {
		t.Errorf("extension uri = %v", extension["uri"])
	}
	params := extension["params"].(map[string]any)
	requestSchema := params["requestSchema"].(map[string]any)
	if requestSchema["$schema"] != "https://json-schema.org/draft/2020-12/schema" {
		t.Errorf("request schema = %v", requestSchema)
	}
	skills := card["skills"].([]any)
	skill := skills[0].(map[string]any)
	if skill["id"] != "coding" || skill["name"] != "Coding" {
		t.Errorf("skill = %v", skill)
	}
}

func TestServerSendMessageEndToEnd(t *testing.T) {
	runtime := &fakeRuntime{
		sessionID: "sess-e2e",
		cwd:       t.TempDir(),
		script: simpleScript(
			agent.StreamText{Text: "hello from yukino"},
			agent.TurnComplete{},
			agent.LoopComplete{StopReason: "end_turn"},
		),
	}
	server := startTestServer(t, runtime)

	body := `{"jsonrpc":"2.0","id":7,"method":"SendMessage","params":{"message":{"messageId":"m-1","role":"user","parts":[{"text":"hi there"}]}}}`
	response, data := postJSON(t, server.URL, map[string]string{"A2A-Version": "1.0", "Content-Type": "application/json"}, body)
	if response.StatusCode != 200 {
		t.Fatalf("status = %d body = %s", response.StatusCode, data)
	}
	var envelope struct {
		JSONRPC string         `json:"jsonrpc"`
		ID      any            `json:"id"`
		Result  map[string]any `json:"result"`
		Error   *struct {
			Code    int    `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(data, &envelope); err != nil {
		t.Fatalf("decode: %v (%s)", err, data)
	}
	if envelope.Error != nil {
		t.Fatalf("rpc error = %+v", envelope.Error)
	}
	if envelope.ID != float64(7) {
		t.Errorf("id = %v", envelope.ID)
	}
	result := envelope.Result
	// The JSON-RPC result wraps the event in a oneof: {"task": {...}}.
	if wrapped, ok := result["task"].(map[string]any); ok {
		result = wrapped
	}
	if result["status"] == nil {
		t.Fatalf("result = %v", result)
	}
	status := result["status"].(map[string]any)
	if status["state"] != "COMPLETED" && status["state"] != "completed" {
		t.Errorf("state = %v", status["state"])
	}
	artifacts, _ := result["artifacts"].([]any)
	found := false
	for _, artifact := range artifacts {
		parts := artifact.(map[string]any)["parts"].([]any)
		for _, part := range parts {
			if text, ok := part.(map[string]any)["text"].(string); ok && strings.Contains(text, "hello from yukino") {
				found = true
			}
		}
	}
	if !found {
		t.Errorf("answer artifact missing: %v", artifacts)
	}
	runtime.mu.Lock()
	runs := append([]string(nil), runtime.runs...)
	runtime.mu.Unlock()
	if len(runs) != 1 || runs[0] != "hi there" {
		t.Errorf("runtime runs = %v", runs)
	}
}

func TestServerRestSendMessage(t *testing.T) {
	runtime := &fakeRuntime{
		sessionID: "sess-rest",
		cwd:       t.TempDir(),
		script: simpleScript(
			agent.StreamText{Text: "rest answer"},
			agent.TurnComplete{},
			agent.LoopComplete{StopReason: "end_turn"},
		),
	}
	server := startTestServer(t, runtime)

	body := `{"message":{"messageId":"m-2","role":"user","parts":[{"text":"hello rest"}]}}`
	response, data := postJSON(t, server.URL+"v1/message:send", map[string]string{"A2A-Version": "1.0", "Content-Type": "application/json"}, body)
	if response.StatusCode != 200 {
		t.Fatalf("status = %d body = %s", response.StatusCode, data)
	}
	var result map[string]any
	if err := json.Unmarshal(data, &result); err != nil {
		t.Fatalf("decode: %v (%s)", err, data)
	}
	if wrapped, ok := result["task"].(map[string]any); ok {
		result = wrapped
	}
	status, ok := result["status"].(map[string]any)
	if !ok {
		t.Fatalf("result = %v", result)
	}
	if !strings.EqualFold(status["state"].(string), "COMPLETED") {
		t.Errorf("state = %v", status["state"])
	}
}

func TestServerStreamingSendMessage(t *testing.T) {
	runtime := &fakeRuntime{
		sessionID: "sess-stream",
		cwd:       t.TempDir(),
		script: func(_ string, emit func(agent.AgentEvent), _ func() bool) {
			emit(agent.StreamText{Text: "chunk-1"})
			time.Sleep(10 * time.Millisecond)
			emit(agent.StreamText{Text: "chunk-2"})
			emit(agent.TurnComplete{})
			emit(agent.LoopComplete{StopReason: "end_turn"})
		},
	}
	server := startTestServer(t, runtime)

	body := `{"jsonrpc":"2.0","id":9,"method":"SendStreamingMessage","params":{"message":{"messageId":"m-3","role":"user","parts":[{"text":"stream it"}]}}}`
	request, err := http.NewRequest("POST", server.URL, bytes.NewReader([]byte(body)))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("A2A-Version", "1.0")
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "text/event-stream")
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != 200 {
		t.Fatalf("status = %d", response.StatusCode)
	}
	data, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	stream := string(data)
	if !strings.Contains(stream, "chunk-1") || !strings.Contains(stream, "chunk-2") {
		t.Fatalf("stream missing chunks: %s", stream)
	}
	if !strings.Contains(strings.ToLower(stream), "completed") {
		t.Fatalf("stream missing terminal state: %s", stream)
	}
}

package httpserver

import (
	"bytes"
	"context"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

func TestStreamableGetPreservesStatusWithoutExtraWriteHeader(t *testing.T) {
	var logs bytes.Buffer
	log.SetOutput(&logs)
	t.Cleanup(func() { log.SetOutput(io.Discard) })

	server := mcp.NewServer(&mcp.Implementation{Name: "yukino-mcp-test", Version: "0.0.1"}, nil)
	httpServer := httptest.NewServer(Handler(server))
	t.Cleanup(httpServer.Close)

	response, err := http.Get(httpServer.URL + "/mcp")
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusMethodNotAllowed {
		t.Fatalf("status = %d, want 405", response.StatusCode)
	}
	if strings.Contains(logs.String(), "superfluous response.WriteHeader") {
		t.Fatalf("deferred renderer wrote the status again:\n%s", logs.String())
	}
}

type recordingTransport struct{ endpoint chan string }

func (r *recordingTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	if req.Method == "POST" {
		select {
		case r.endpoint <- req.URL.RequestURI():
		default:
		}
	}
	return http.DefaultTransport.RoundTrip(req)
}

func TestLegacySSEUsesTSMessageRouteAndCleansUp(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	server := mcp.NewServer(&mcp.Implementation{Name: "test", Version: "1"}, nil)
	httpServer := httptest.NewServer(Handler(server))
	defer httpServer.Close()
	recorder := &recordingTransport{endpoint: make(chan string, 10)}
	client := mcp.NewClient(&mcp.Implementation{Name: "test", Version: "1"}, nil)
	session, err := client.Connect(ctx, &mcp.SSEClientTransport{Endpoint: httpServer.URL + "/sse", HTTPClient: &http.Client{Transport: recorder}}, nil)
	if err != nil {
		t.Fatal(err)
	}
	endpoint := <-recorder.endpoint
	if !strings.HasPrefix(endpoint, "/messages?sessionId=") {
		t.Fatalf("legacy endpoint: %s", endpoint)
	}
	if _, err := session.ListTools(ctx, nil); err != nil {
		t.Fatal(err)
	}
	if err := session.Close(); err != nil {
		t.Fatal(err)
	}
	// Closing the SSE stream removes the session; no stale transport can accept a POST.
	deadline := time.Now().Add(time.Second)
	for {
		response, err := http.Post(httpServer.URL+endpoint, "application/json", strings.NewReader(`{"jsonrpc":"2.0","method":"notifications/initialized"}`))
		if err != nil {
			t.Fatal(err)
		}
		body, _ := io.ReadAll(response.Body)
		_ = response.Body.Close()
		if response.StatusCode == http.StatusBadRequest {
			if !strings.Contains(string(body), "Unknown session") {
				t.Fatalf("unknown session: %s", body)
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("closed SSE session remains registered")
		}
		time.Sleep(time.Millisecond)
	}
}

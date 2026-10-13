package httpserver

import (
	"bytes"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

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

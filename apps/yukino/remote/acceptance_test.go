package remote

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"reflect"
	"regexp"
	"strings"
	"sync"
	"testing"

	"github.com/gorilla/websocket"
	"github.com/yukino-js/yukino/yukino/config"
	"github.com/yukino-js/yukino/yukino/conversation"
	"github.com/yukino-js/yukino/yukino/llm"
	"github.com/yukino-js/yukino/yukino/session"
	"github.com/yukino-js/yukino/yukino/tools"
)

type failedCompactClient struct{}

func (failedCompactClient) SetSystemPrompt(string) {}
func (failedCompactClient) Stream(context.Context, *conversation.Manager, []map[string]any) (<-chan llm.StreamEvent, <-chan error) {
	events, failures := make(chan llm.StreamEvent), make(chan error, 1)
	failures <- errors.New("fixture compact failure")
	close(events)
	close(failures)
	return events, failures
}

func TestHostFailuresMatchReference(t *testing.T) {
	data, err := os.ReadFile("testdata/host-failures.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		Scenarios []struct {
			Name     string
			Messages []map[string]any
		}
	}
	if err := json.Unmarshal(data, &fixture); err != nil {
		t.Fatal(err)
	}
	for _, test := range fixture.Scenarios {
		t.Run(test.Name, func(t *testing.T) {
			s := newTestServer(t, failedCompactClient{})
			s.providers = append(s.providers, config.ProviderConfig{Name: "bad", Protocol: "invalid"})
			s.provider = &config.ProviderConfig{Name: "p", Protocol: "openai", Model: "m"}
			s.ag.RecoveryState = nil
			serverConn, client := dialPair(t, s)
			switch test.Name {
			case "provider-unknown":
				s.applyProviderSwitch(99)
			case "provider-failed":
				s.applyProviderSwitch(1)
			case "provider-save-failed":
				s.handleProviderSave(map[string]any{"name": "", "protocol": "openai", "base_url": "https://example.invalid", "api_key": "test", "model": "m"})
			case "model-failed":
				s.provider.Protocol = "invalid"
				s.applyModel("next")
			case "model-unchanged":
				s.applyModel("m")
			case "image-empty":
				s.handleImageUpload(serverConn, imageUploadData{ClientID: "image", Name: "empty.png"})
			case "image-invalid":
				s.handleImageUpload(serverConn, imageUploadData{ClientID: "image", Name: "invalid.png", DataBase64: "bm90IGFuIGltYWdl"})
			case "resume-missing":
				s.handleResume("missing")
			case "resume-invalid-index":
				s.handleResume("1x")
			case "compact-failed":
				for i := 0; i < 30; i++ {
					role := "user"
					if i%2 != 0 {
						role = "assistant"
					}
					s.conv.AppendMessages([]conversation.Message{{Role: role, Content: fmt.Sprintf("message %d", i)}})
				}
				s.handleCompact(context.Background(), "fixture instructions")
			default:
				t.Fatal("unhandled reference scenario", test.Name)
			}
			for _, expected := range test.Messages {
				actual := readJSON(t, client)
				if payload, ok := actual["data"].(map[string]any); ok {
					if text, ok := payload["message"].(string); ok {
						payload["message"] = regexp.MustCompile(`^(Failed to (?:switch provider|switch model|save provider)): [\s\S]*$`).ReplaceAllString(text, "$1: <runtime-error>")
					}
				}
				if !reflect.DeepEqual(actual, expected) {
					t.Fatalf("actual=%#v, reference=%#v", actual, expected)
				}
			}
		})
	}
}

func TestBootstrapSnapshotsDuringInitializationAndProviderChanges(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Chdir(t.TempDir())
	providers := []config.ProviderConfig{
		{Name: "a", Protocol: "openai", BaseURL: "https://a.invalid", Model: "a", APIKey: "test", ContextWindow: 64000},
		{Name: "b", Protocol: "openai", BaseURL: "https://b.invalid", Model: "b", APIKey: "test", ContextWindow: 128000},
	}
	s := NewServer(providers, nil, nil, "", false, 0, nil, false)
	t.Cleanup(s.Stop)
	var wg sync.WaitGroup
	failures := make(chan error, 4)
	start := make(chan struct{})
	for reader := 0; reader < 4; reader++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			for n := 0; n < 100; n++ {
				s.snapshotMu.RLock()
				messages := s.bootstrapMessages()
				s.snapshotMu.RUnlock()
				var status, usage map[string]any
				connected := false
				for _, message := range messages {
					switch message.Type {
					case "connected":
						connected = message.Data.(map[string]any)["session"] != ""
					case "status":
						status = message.Data.(map[string]any)
					case "usage":
						usage = message.Data.(map[string]any)
					}
				}
				if status == nil && usage == nil && !connected {
					continue
				}
				if status == nil || usage == nil || !connected || status["contextWindow"] != usage["contextWindow"] {
					failures <- fmt.Errorf("incomplete snapshot: %#v", messages)
					return
				}
				want := 64000
				if status["provider"] == "b" {
					want = 128000
				}
				if status["contextWindow"] != want {
					failures <- fmt.Errorf("mixed provider snapshot: %#v", status)
					return
				}
			}
		}()
	}
	close(start)
	if !s.ensureAgent() {
		t.Fatal("initialization failed")
	}
	for n := 0; n < 20; n++ {
		s.changeProviderConfiguration(func() { s.applyProviderSwitch(n % 2) })
		s.changeProviderConfiguration(func() { s.applyModel(fmt.Sprintf("model-%d", n)) })
	}
	wg.Wait()
	close(failures)
	for err := range failures {
		t.Error(err)
	}
}

func TestWebSocketProviderFailureReleasesRunSlot(t *testing.T) {
	s := newTestServer(t, &stubClient{})
	s.providers = append(s.providers, config.ProviderConfig{Name: "invalid", Protocol: "invalid"})
	server := httptest.NewServer(http.HandlerFunc(s.handleWS))
	t.Cleanup(server.Close)
	conn, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(server.URL, "http")+"/ws?token="+s.accessToken, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { conn.Close() })
	for readJSON(t, conn)["type"] != "usage" {
	}
	for _, index := range []int{99, 1} {
		if err := conn.WriteJSON(map[string]any{"type": "provider_select", "data": map[string]any{"index": index}}); err != nil {
			t.Fatal(err)
		}
		if msg := readJSON(t, conn); msg["type"] != "run_state" || msg["data"].(map[string]any)["streaming"] != true {
			t.Fatal(msg)
		}
		if msg := readJSON(t, conn); msg["type"] != "error" {
			t.Fatal(msg)
		}
		if msg := readJSON(t, conn); msg["type"] != "run_state" || msg["data"].(map[string]any)["streaming"] != false {
			t.Fatal(msg)
		}
	}
	if err := conn.WriteJSON(map[string]any{"type": "ping", "data": nil}); err != nil {
		t.Fatal(err)
	}
	if msg := readJSON(t, conn); msg["type"] != "pong" {
		t.Fatal(msg)
	}
}

func TestFailedProviderReplacementKeepsActiveProviderSnapshot(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Chdir(t.TempDir())
	s := NewServer([]config.ProviderConfig{{Name: "active", Protocol: "openai", BaseURL: "https://example.invalid", Model: "active-model", APIKey: "test"}}, nil, nil, "", false, 0, nil, false)
	t.Cleanup(s.Stop)
	if !s.ensureAgent() {
		t.Fatal("initialization failed")
	}
	oldClient := s.client
	s.providers[0] = config.ProviderConfig{Name: "replacement", Protocol: "invalid", Model: "replacement-model"}
	s.applyProviderSwitch(0)
	message, ok := s.statusPayload()
	if !ok {
		t.Fatal("active runtime disappeared")
	}
	status := message.Data.(map[string]any)
	if s.client != oldClient || status["model"] != "active-model" || status["provider"] != "active" {
		t.Fatalf("failed replacement changed active provider: %#v", status)
	}
}

func TestSandboxRuntimeSurvivesSessionResetAndDisposes(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Chdir(t.TempDir())
	s := NewServer([]config.ProviderConfig{{Name: "p", Protocol: "openai", BaseURL: "https://example.invalid", Model: "m", APIKey: "test"}}, nil, nil, "", false, 0, nil, false)
	t.Cleanup(s.Stop)
	if !s.ensureAgent() {
		t.Fatal("initialization failed")
	}
	s.handleSandboxCommand(" auto ")
	first := s.sandboxRuntime.Get()
	tool := s.registry.Get("Bash").(*tools.BashTool)
	if !tool.SandboxRequired || !s.ag.Checker.SandboxEnabled || !s.ag.Checker.SandboxAutoAllow {
		t.Fatal("sandbox mode not applied")
	}
	if err := s.clearConversation(); err != nil {
		t.Fatal(err)
	}
	if s.sandboxRuntime.Get() != first || tool.Sandbox != first {
		t.Fatal("clear discarded cached sandbox")
	}
	if err := s.restoreSession(session.NewID(), []conversation.Message{{Role: "user", Content: "restored"}}); err != nil {
		t.Fatal(err)
	}
	if s.sandboxRuntime.Get() != first || tool.Sandbox != first {
		t.Fatal("resume discarded cached sandbox")
	}
	s.handleSandboxCommand("off")
	if tool.SandboxRequired || tool.Sandbox != nil || s.ag.Checker.SandboxEnabled || s.ag.Checker.SandboxAutoAllow {
		t.Fatal("sandbox was not disposed")
	}
}

func TestLateJoinBootstrapIsContiguousDuringProviderChanges(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Chdir(t.TempDir())
	s := NewServer([]config.ProviderConfig{{Name: "p", Protocol: "openai", BaseURL: "https://example.invalid", Model: "m", APIKey: "test"}}, nil, nil, "", false, 0, nil, false)
	t.Cleanup(s.Stop)
	if !s.ensureAgent() {
		t.Fatal("initialization failed")
	}
	server := httptest.NewServer(http.HandlerFunc(s.handleWS))
	t.Cleanup(server.Close)
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		for n := 0; n < 30; n++ {
			s.changeProviderConfiguration(func() { s.applyModel(fmt.Sprintf("model-%d", n)) })
		}
	}()
	defer wg.Wait()
	for n := 0; n < 10; n++ {
		conn, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(server.URL, "http")+"/ws?token="+s.accessToken, nil)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { conn.Close() })
		for readJSON(t, conn)["type"] != "connected" {
		}
		status := readJSON(t, conn)
		if status["type"] != "status" {
			t.Fatal(status)
		}
		for _, kind := range []string{"commands", "history", "usage"} {
			message := readJSON(t, conn)
			if message["type"] != kind {
				t.Fatalf("bootstrap interrupted by %v, expected %s", message, kind)
			}
			if kind == "usage" && status["data"].(map[string]any)["contextWindow"] != message["data"].(map[string]any)["contextWindow"] {
				t.Fatal("mixed bootstrap", status, message)
			}
		}
		conn.Close()
	}
}

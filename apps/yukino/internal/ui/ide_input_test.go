package ui

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/yukino-js/yukino/yukino/internal/config"
	"github.com/yukino-js/yukino/yukino/internal/vscode"
)

func ideIntPtr(v int) *int { return &v }

func TestIdeMentionText(t *testing.T) {
	cwd := "/work/project"
	cases := []struct {
		name    string
		mention vscode.IdeAtMention
		want    string
	}{
		{
			name:    "relative path without lines",
			mention: vscode.IdeAtMention{FilePath: "/work/project/src/main.go"},
			want:    "@src/main.go ",
		},
		{
			name:    "outside cwd keeps absolute path",
			mention: vscode.IdeAtMention{FilePath: "/other/file.go"},
			want:    "@/other/file.go ",
		},
		{
			name:    "single line",
			mention: vscode.IdeAtMention{FilePath: "/work/project/a.go", LineStart: ideIntPtr(5), LineEnd: ideIntPtr(5)},
			want:    "@a.go#L5 ",
		},
		{
			name:    "line range",
			mention: vscode.IdeAtMention{FilePath: "/work/project/a.go", LineStart: ideIntPtr(5), LineEnd: ideIntPtr(9)},
			want:    "@a.go#L5-9 ",
		},
		{
			name:    "start without end",
			mention: vscode.IdeAtMention{FilePath: "/work/project/a.go", LineStart: ideIntPtr(3)},
			want:    "@a.go#L3 ",
		},
		{
			name:    "end without start is ignored",
			mention: vscode.IdeAtMention{FilePath: "/work/project/a.go", LineEnd: ideIntPtr(3)},
			want:    "@a.go ",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := ideMentionText(cwd, tc.mention); got != tc.want {
				t.Fatalf("ideMentionText = %q, want %q", got, tc.want)
			}
		})
	}
}

func newIdeTestModel(t *testing.T) Model {
	t.Helper()
	t.Setenv("HOME", t.TempDir())
	provider := config.ProviderConfig{Name: "test", Protocol: "anthropic", Model: "m", APIKey: "k"}
	m := New([]config.ProviderConfig{provider}, nil, nil, nil, 0, "", true)
	m.sessionID = "ide-test"
	return m
}

func TestUpdateInsertsRelativeMention(t *testing.T) {
	wd := t.TempDir()
	t.Chdir(wd)
	m := newIdeTestModel(t)
	m.editor.SetValue("prefix ")

	updated, cmd := m.Update(ideAtMentionMsg{mention: vscode.IdeAtMention{
		FilePath:  filepath.Join(wd, "sub", "file.go"),
		LineStart: ideIntPtr(2),
		LineEnd:   ideIntPtr(4),
	}})
	model := updated.(Model)
	if cmd == nil {
		t.Fatal("expected the mention listener to restart")
	}
	want := "prefix @sub/file.go#L2-4 "
	if got := model.editor.Value(); got != want {
		t.Fatalf("textarea = %q, want %q", got, want)
	}
}

func TestUpdateInsertsAbsoluteMention(t *testing.T) {
	t.Chdir(t.TempDir())
	m := newIdeTestModel(t)
	m.editor.SetValue("")

	updated, cmd := m.Update(ideAtMentionMsg{mention: vscode.IdeAtMention{FilePath: "/elsewhere/file.go"}})
	model := updated.(Model)
	if cmd == nil {
		t.Fatal("expected the mention listener to restart")
	}
	if got := model.editor.Value(); got != "@/elsewhere/file.go " {
		t.Fatalf("textarea = %q", got)
	}
}

func TestUpdateStoresIdeConnection(t *testing.T) {
	m := newIdeTestModel(t)
	cancelled := false
	conn := &vscode.IdeConnection{IdeName: "VS Code", Close: func() error { return nil }}
	updated, cmd := m.Update(ideConnectedMsg{connection: conn, cancel: func() { cancelled = true }})
	model := updated.(Model)
	if model.ideConn != conn || model.ideCancel == nil {
		t.Fatal("expected connection and cancel to be stored")
	}
	if cmd == nil {
		t.Fatal("expected the mention listener to start")
	}
	model.ideCancel()
	if !cancelled {
		t.Fatal("expected cancel to run")
	}
}

func TestDisposeClosesIdeConnection(t *testing.T) {
	m := newIdeTestModel(t)
	closed := false
	cancelled := false
	m.ideConn = &vscode.IdeConnection{IdeName: "VS Code", Close: func() error { closed = true; return nil }}
	m.ideCancel = func() { cancelled = true }
	if err := m.Dispose(); err != nil {
		t.Fatalf("dispose: %v", err)
	}
	if !closed || !cancelled {
		t.Fatalf("expected ide cleanup: closed=%v cancelled=%v", closed, cancelled)
	}
}

func TestConnectIdeNoIdeReturnsNilMsg(t *testing.T) {
	m := newIdeTestModel(t)
	t.Setenv("CLAUDE_CONFIG_DIR", t.TempDir())
	os.Unsetenv("CLAUDE_CODE_SSE_PORT")
	os.Unsetenv("TERM_PROGRAM")
	cmd := m.connectIde()
	if cmd == nil {
		t.Fatal("expected a command")
	}
	if msg := cmd(); msg != nil {
		t.Fatalf("expected nil msg without an IDE, got %v", msg)
	}
}

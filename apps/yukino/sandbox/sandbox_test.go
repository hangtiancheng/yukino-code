package sandbox

import (
	"context"
	"strings"
	"testing"
)

func TestSandboxArgumentVectorsAndProfileEscaping(t *testing.T) {
	cfg := Config{AllowWrite: []string{"."}, DenyWrite: []string{"private"}}
	bwrap, err := (&BwrapSandbox{}).Prepare(context.Background(), "true; echo still-contained", cfg, "/workspace")
	if err != nil || bwrap.Executable != "bwrap" || strings.Join(bwrap.Args[len(bwrap.Args)-4:], "|") != "--|bash|-c|true; echo still-contained" {
		t.Fatal(bwrap, err)
	}
	if !strings.Contains(strings.Join(bwrap.Args, " "), "--die-with-parent") {
		t.Fatal("missing parent death cleanup")
	}
	seatbelt, err := (&SeatbeltSandbox{}).Prepare(context.Background(), "printf ok", cfg, "/workspace")
	if err != nil || seatbelt.Executable != SandboxExecPath {
		t.Fatal(seatbelt, err)
	}
	for _, want := range []string{`(deny file-write* (literal "/workspace/private"))`, `(deny file-write* (subpath "/workspace/private"))`, `(allow file-write* (literal "/dev/null"))`} {
		if !strings.Contains(seatbelt.Args[1], want) {
			t.Fatal(seatbelt.Args[1])
		}
	}
	if cfg.AllowWrite[0] != "." || cfg.DenyWrite[0] != "private" {
		t.Fatal("configuration mutated")
	}
	quoted, err := quoteProfileString("/tmp/a\"\\) (allow network*)")
	if err != nil || quoted != `"/tmp/a\"\\) (allow network*)"` {
		t.Fatal(quoted, err)
	}
	for _, path := range []string{"/tmp/safe\n(allow network*)", "/tmp/null\x00"} {
		if _, err := (&SeatbeltSandbox{}).Prepare(context.Background(), "true", Config{AllowWrite: []string{path}}, "/workspace"); err == nil {
			t.Fatal("profile injection accepted")
		}
	}
}

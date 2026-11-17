package teams

import "testing"

func TestNameRegistryResolve(t *testing.T) {
	reg := GetNameRegistry()
	reg.Clear()
	defer reg.Clear()

	reg.Register("reviewer", "agent-7")

	if got := reg.Resolve("reviewer"); got != "agent-7" {
		t.Fatalf("resolve by name = %q, want agent-7", got)
	}
	if got := reg.Resolve("agent-7"); got != "agent-7" {
		t.Fatalf("resolve by id = %q, want agent-7", got)
	}
	if got := reg.Resolve("ghost"); got != "" {
		t.Fatalf("resolve unknown = %q, want empty", got)
	}
}

func TestNameRegistryUnregister(t *testing.T) {
	reg := GetNameRegistry()
	reg.Clear()
	defer reg.Clear()

	reg.Register("reviewer", "agent-7")
	reg.Unregister("reviewer")
	if got := reg.Resolve("reviewer"); got != "" {
		t.Fatalf("resolve after unregister = %q, want empty", got)
	}
}

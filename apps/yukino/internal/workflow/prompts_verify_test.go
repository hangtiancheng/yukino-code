package workflow

import (
	"crypto/sha256"
	"encoding/hex"
	"testing"
)

func hash16(s string) string {
	sum := sha256.Sum256([]byte(s))
	return hex.EncodeToString(sum[:])[:16]
}

// Reference hashes captured from src/workflow/prompts.ts via npx tsx.
func TestPromptHashes(t *testing.T) {
	cases := map[string]struct{ got, want string }{
		"tool":         {hash16(WorkflowToolPrompt), "3dfce7551d57c2f1"},
		"ultra":        {hash16(UltracodePrompt), "0f516139a20b7c21"},
		"rule":         {hash16(WorkflowRule), "0c06789a4141013d"},
		"named":        {hash16(BuildNamedWorkflowPrompt("my-flow", "some args")), "f5bec61a495e0c56"},
		"named-noargs": {hash16(BuildNamedWorkflowPrompt("my-flow", "")), "33fb758f85d309b8"},
		"structured":   {hash16(BuildStructuredOutputPrompt("do it", `{"type":"object","properties":{"a":{"type":"string"}}}`)), "810cbda96d05e2af"},
	}
	for name, c := range cases {
		if c.got != c.want {
			t.Errorf("%s hash = %s, want %s", name, c.got, c.want)
		}
	}
}

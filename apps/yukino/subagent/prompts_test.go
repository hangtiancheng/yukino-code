package subagent

import (
	"crypto/sha256"
	"encoding/hex"
	"testing"
)

func promptHash(s string) string {
	sum := sha256.Sum256([]byte(s))
	return hex.EncodeToString(sum[:])[:16]
}

// The Agent-tool prompt strings must stay byte-identical to the reference;
// the hashes were produced by src/subagent/prompts.ts.
func TestAgentToolPromptParity(t *testing.T) {
	if got := promptHash(ForkParameterDescription); got != "0c024d82920c3471" {
		t.Errorf("ForkParameterDescription hash = %s, want 0c024d82920c3471\n%s", got, ForkParameterDescription)
	}
	defs := []SubAgentSpec{
		{Name: "general-purpose", Description: "General purpose agent"},
		{Name: PlanAgentName, Description: "Plan agent"},
	}
	if got := promptHash(buildAgentToolDescription(defs)); got != "2c45d4f3df20664c" {
		t.Errorf("buildAgentToolDescription hash = %s, want 2c45d4f3df20664c", got)
	}
}

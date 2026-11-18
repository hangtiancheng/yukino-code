package compact

import (
	"crypto/sha256"
	"encoding/hex"
	"testing"
)

func hash16(s string) string {
	sum := sha256.Sum256([]byte(s))
	return hex.EncodeToString(sum[:])[:16]
}

// Reference hashes captured from src/compact/prompts.ts via npx tsx.
func TestPromptHashes(t *testing.T) {
	cases := map[string]struct{ got, want string }{
		"instructions": {hash16(SummaryInstructions), "940acc32c19fac91"},
		"custom":       {hash16(BuildSummaryInstructions("  focus here  ")), "c6b2f23baa851567"},
		"prompt":       {hash16(BuildSummaryPrompt("CONV", "")), "c5adf54fcd9f2ec1"},
		"msg":          {hash16(BuildCompactionSummaryMessage("SUM", true)), "4a90661e25aa54c0"},
		"msg2":         {hash16(BuildCompactionSummaryMessage("SUM", false)), "d1d826e1f970509a"},
		"hint":         {hash16(BuildSessionTranscriptHint("/path/to/session.jsonl")), "7b15d3eba0809dd8"},
		"divider":      {hash16(RecoveryAttachmentDivider), "ad1af52e2872615a"},
	}
	for name, c := range cases {
		if c.got != c.want {
			t.Errorf("%s hash = %s, want %s", name, c.got, c.want)
		}
	}
}

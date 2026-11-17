package ui

import (
	"math"
	"testing"
)

type fuseModel struct {
	ID          string
	DisplayName string
	Name        string
}

type fuseProvider struct {
	Name     string
	Protocol string
	BaseURL  string
	Model    string
}

type fuseCommand struct {
	Name        string
	Description string
}

func modelKeys() []fuseKey[fuseModel] {
	return []fuseKey[fuseModel]{
		{weight: 1, get: func(m fuseModel) (string, bool) { return m.ID, true }},
		{weight: 1, get: func(m fuseModel) (string, bool) { return m.DisplayName, m.DisplayName != "" }},
		{weight: 1, get: func(m fuseModel) (string, bool) { return m.Name, m.Name != "" }},
	}
}

var fuseTestModels = []fuseModel{
	{ID: "claude-sonnet-4-5-20250929", DisplayName: "Claude Sonnet 4.5", Name: "sonnet"},
	{ID: "claude-opus-4-1", DisplayName: "Claude Opus 4.1", Name: "opus"},
	{ID: "claude-haiku-3-5", Name: "haiku"},
	{ID: "gpt-5-codex", DisplayName: "GPT-5 Codex", Name: "codex"},
	{ID: "gpt-4o-mini", DisplayName: "GPT-4o mini", Name: "mini"},
	{ID: "o3-pro"},
}

type fuseExpectation struct {
	id    string
	score float64
}

func checkResults(t *testing.T, label string, gotIDs []string, gotScores []float64, want []fuseExpectation) {
	t.Helper()
	if len(gotIDs) != len(want) {
		t.Fatalf("%s: got %d results %v, want %d", label, len(gotIDs), gotIDs, len(want))
	}
	for i, w := range want {
		if gotIDs[i] != w.id {
			t.Fatalf("%s: result %d = %s, want %s (full: %v)", label, i, gotIDs[i], w.id, gotIDs)
		}
		if math.Abs(gotScores[i]-w.score) > 1e-12 {
			t.Fatalf("%s: score for %s = %.17g, want %.17g", label, w.id, gotScores[i], w.score)
		}
	}
}

// TestFuseModelSearch pins the port against fuse.js 7.5.0 output for the
// model-select keys (id/display_name/name, threshold 0.35, ignoreLocation).
func TestFuseModelSearch(t *testing.T) {
	f := NewFuse(fuseTestModels, modelKeys(), 0.35, true)
	search := func(query string) ([]string, []float64) {
		items := f.Search(query)
		ids := make([]string, len(items))
		for i, item := range items {
			ids[i] = item.ID
		}
		return ids, rescoreFuse(f, items, query, 0.35, true)
	}

	ids, scores := search("sonnet")
	checkResults(t, "q=sonnet", ids, scores, []fuseExpectation{
		{"claude-sonnet-4-5-20250929", 1.603787195649034e-7},
	})

	ids, scores = search("claude")
	checkResults(t, "q=claude", ids, scores, []fuseExpectation{
		{"claude-sonnet-4-5-20250929", 0.02648500138606702},
		{"claude-opus-4-1", 0.02648500138606702},
		{"claude-haiku-3-5", 0.10000000000000002},
	})

	ids, scores = search("gpt")
	checkResults(t, "q=gpt", ids, scores, []fuseExpectation{
		{"gpt-5-codex", 0.019633602768360476},
		{"gpt-4o-mini", 0.019633602768360476},
	})

	ids, scores = search("opus 4")
	checkResults(t, "q=opus 4", ids, scores, []fuseExpectation{
		{"claude-opus-4-1", 0.10105919433558548},
	})

	ids, _ = search("zzz")
	checkResults(t, "q=zzz", ids, nil, nil)

	ids, scores = search("clade")
	checkResults(t, "q=clade", ids, scores, []fuseExpectation{
		{"claude-sonnet-4-5-20250929", 0.4291160590884254},
		{"claude-opus-4-1", 0.4291160590884254},
		{"claude-haiku-3-5", 0.5848035476425733},
	})

	ids, scores = search("codex")
	checkResults(t, "q=codex", ids, scores, []fuseExpectation{
		{"gpt-5-codex", 1.188903873001907e-7},
	})

	ids, scores = search("4-5")
	checkResults(t, "q=4-5", ids, scores, []fuseExpectation{
		{"claude-sonnet-4-5-20250929", 0.08095313625349508},
		{"gpt-5-codex", 0.5352023430657528},
		{"claude-opus-4-1", 0.6933612743506347},
		{"claude-haiku-3-5", 0.6933612743506347},
	})
}

// TestFuseProviderSearch pins the provider-select keys.
func TestFuseProviderSearch(t *testing.T) {
	providers := []fuseProvider{
		{Name: "Anthropic prod", Protocol: "anthropic", BaseURL: "https://api.anthropic.com", Model: "claude-sonnet-4-5"},
		{Name: "OpenAI", Protocol: "openai", BaseURL: "https://api.openai.com/v1", Model: "gpt-5"},
		{Name: "Local llama", Protocol: "openai-compat", BaseURL: "http://localhost:11434/v1", Model: "llama3.1"},
	}
	keys := []fuseKey[fuseProvider]{
		{weight: 1, get: func(p fuseProvider) (string, bool) { return p.Name, true }},
		{weight: 1, get: func(p fuseProvider) (string, bool) { return p.Protocol, true }},
		{weight: 1, get: func(p fuseProvider) (string, bool) { return p.BaseURL, true }},
		{weight: 1, get: func(p fuseProvider) (string, bool) { return p.Model, true }},
	}
	f := NewFuse(providers, keys, 0.35, true)

	cases := []struct {
		query string
		want  []fuseExpectation
	}{
		{"local", []fuseExpectation{{"Local llama", 0.05245054437267897}}},
		{"openai", []fuseExpectation{{"OpenAI", 2.6498428136690303e-9}, {"Local llama", 0.1778279410038923}}},
		{"llama", []fuseExpectation{{"Local llama", 0.05245054437267897}}},
		{"anthropic", []fuseExpectation{{"Anthropic prod", 0.000006402654342368039}}},
	}
	for _, c := range cases {
		items := f.Search(c.query)
		ids := make([]string, len(items))
		for i, item := range items {
			ids[i] = item.Name
		}
		scores := rescoreFuse(f, items, c.query, 0.35, true)
		checkResults(t, "p="+c.query, ids, scores, c.want)
	}
}

// TestFuseWeightedCommandSearch pins the slash-menu keys (name weight 3,
// aliases weight 2 never present, description weight 0.5, threshold 0.4).
func TestFuseWeightedCommandSearch(t *testing.T) {
	cmds := []fuseCommand{
		{Name: "help", Description: "Show available commands"},
		{Name: "clear", Description: "Clear conversation and start fresh"},
		{Name: "compact", Description: "Compact the conversation history"},
		{Name: "model", Description: "Switch the active model"},
		{Name: "thinking", Description: "Set the thinking level"},
	}
	keys := []fuseKey[fuseCommand]{
		{weight: 3, get: func(c fuseCommand) (string, bool) { return c.Name, true }},
		{weight: 2, get: func(c fuseCommand) (string, bool) { return "", false }},
		{weight: 0.5, get: func(c fuseCommand) (string, bool) { return c.Description, true }},
	}
	f := NewFuse(cmds, keys, 0.4, false)

	cases := []struct {
		query string
		want  []fuseExpectation
	}{
		{"mod", []fuseExpectation{{"model", 0.021369045012014264}}},
		{"clear", []fuseExpectation{{"clear", 2.1866817358011047e-9}}},
		{"thnk", []fuseExpectation{{"thinking", 0.446393550300526}}},
		{"hepl", []fuseExpectation{{"help", 0.4694654553308532}}},
	}
	for _, c := range cases {
		items := f.Search(c.query)
		ids := make([]string, len(items))
		for i, item := range items {
			ids[i] = item.Name
		}
		scores := rescoreFuse(f, items, c.query, 0.4, false)
		checkResults(t, "c="+c.query, ids, scores, c.want)
	}
}

// TestFuseLongPattern covers the >32-char chunking path.
func TestFuseLongPattern(t *testing.T) {
	items := []fuseModel{
		{ID: "a-very-long-model-identifier-that-exceeds-thirty-two-chars"},
		{ID: "other"},
	}
	f := NewFuse(items, []fuseKey[fuseModel]{
		{weight: 1, get: func(m fuseModel) (string, bool) { return m.ID, true }},
	}, 0.35, true)
	for _, query := range []string{"exceeds-thirty", "a-very-long-model-identifier-that-exceeds", "identifier"} {
		got := f.Search(query)
		if len(got) != 1 || got[0].ID != items[0].ID {
			t.Fatalf("long=%s: got %v", query, got)
		}
		scores := rescoreFuse(f, got, query, 0.35, true)
		checkResults(t, "long="+query, []string{got[0].ID}, scores, []fuseExpectation{{items[0].ID, 0.001}})
	}
}

// rescoreFuse recomputes result scores so tests can pin exact fuse.js values.
func rescoreFuse[T any](f *Fuse[T], items []T, query string, threshold float64, ignoreLocation bool) []float64 {
	searcher := newBitapSearch(query, threshold, ignoreLocation)
	scores := make([]float64, len(items))
	for i, item := range items {
		var matches []fuseMatch
		for _, key := range f.keys {
			text, ok := key.get(item)
			if !ok {
				continue
			}
			if isMatch, score := searcher.searchIn([]rune(text)); isMatch {
				matches = append(matches, fuseMatch{score: score, weight: key.weight, norm: fieldNorm(text, 1)})
			}
		}
		scores[i] = computeScoreSingle(matches)
	}
	return scores
}

package docs

import "testing"

func TestSplitMarkdownKeepsSmallDocument(t *testing.T) {
	chunks := SplitMarkdown("# One\nalpha\nbeta")
	if len(chunks) != 1 {
		t.Fatalf("chunks = %d, want 1", len(chunks))
	}
	if chunks[0].Title != "One" || !contains(chunks[0].Content, "alpha") {
		t.Fatalf("chunk = %#v", chunks[0])
	}
}

func TestSplitMarkdownBoundsLargeDocuments(t *testing.T) {
	var b []byte
	for i := 0; i < 8; i++ {
		b = append(b, "# Section "...)
		b = append(b, byte('0'+i))
		b = append(b, '\n')
		for n := 0; n < 120; n++ {
			b = append(b, "word "...)
		}
		b = append(b, '\n')
	}
	chunks := SplitMarkdown(string(b))
	if len(chunks) < 2 {
		t.Fatalf("chunks = %d, want more than 1", len(chunks))
	}
	for _, chunk := range chunks {
		if len(chunk.Content) > ChunkSize {
			t.Fatalf("chunk length %d exceeds %d", len(chunk.Content), ChunkSize)
		}
	}
}

func TestSplitMarkdownCarriesHeading(t *testing.T) {
	content := "# Only Title\n" + repeat("text ", 600)
	chunks := SplitMarkdown(content)
	if len(chunks) < 2 {
		t.Fatalf("chunks = %d, want more than 1", len(chunks))
	}
	for _, chunk := range chunks {
		if chunk.Title != "Only Title" {
			t.Fatalf("title = %q", chunk.Title)
		}
	}
}

func TestSplitMarkdownHardSplitsLongLine(t *testing.T) {
	chunks := SplitMarkdown(repeat("x", ChunkSize*3))
	if len(chunks) < 2 {
		t.Fatalf("chunks = %d, want more than 1", len(chunks))
	}
	for _, chunk := range chunks {
		if len(chunk.Content) > ChunkSize {
			t.Fatalf("chunk length %d exceeds %d", len(chunk.Content), ChunkSize)
		}
	}
}

func TestSplitMarkdownEmpty(t *testing.T) {
	if chunks := SplitMarkdown(""); len(chunks) != 0 {
		t.Fatalf("empty produced %#v", chunks)
	}
	if chunks := SplitMarkdown("  \n  "); len(chunks) != 0 {
		t.Fatalf("whitespace produced %#v", chunks)
	}
	chunks := SplitMarkdown("plain text file")
	if len(chunks) != 1 || chunks[0].Title != "" || chunks[0].Content != "plain text file" {
		t.Fatalf("plain = %#v", chunks)
	}
}

func contains(s, part string) bool {
	return len(s) >= len(part) && (s == part || len(part) == 0 || (len(s) > 0 && (stringIndex(s, part) >= 0)))
}

func stringIndex(s, part string) int {
	for i := 0; i+len(part) <= len(s); i++ {
		if s[i:i+len(part)] == part {
			return i
		}
	}
	return -1
}

func repeat(s string, n int) string {
	out := make([]byte, 0, len(s)*n)
	for i := 0; i < n; i++ {
		out = append(out, s...)
	}
	return string(out)
}

package conversation

import (
	"bytes"
	"image"
	"image/color"
	"image/png"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writeSmallPNG(t *testing.T, path string) {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, 8, 8))
	for y := 0; y < 8; y++ {
		for x := 0; x < 8; x++ {
			img.Set(x, y, color.RGBA{R: uint8(x * 30), G: uint8(y * 30), B: 99, A: 255})
		}
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, buf.Bytes(), 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestExpandAtRefsWithImagesNoRefs(t *testing.T) {
	expanded, blocks := ExpandAtRefsWithImages("plain text", t.TempDir())
	if expanded != "plain text" || blocks != nil {
		t.Fatalf("got %q, %v", expanded, blocks)
	}
}

func TestExpandAtRefsWithImagesTextRef(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "note.txt"), []byte("hello"), 0o600); err != nil {
		t.Fatal(err)
	}
	expanded, blocks := ExpandAtRefsWithImages("see @note.txt", dir)
	if blocks != nil {
		t.Fatalf("text-only refs must not produce blocks: %v", blocks)
	}
	if !strings.Contains(expanded, "<file path=\"note.txt\">\nhello\n</file>") {
		t.Fatalf("expanded = %q", expanded)
	}
}

func TestExpandAtRefsWithImagesImageRef(t *testing.T) {
	dir := t.TempDir()
	writeSmallPNG(t, filepath.Join(dir, "pic.png"))

	expanded, blocks := ExpandAtRefsWithImages("look at @pic.png", dir)
	if blocks == nil {
		t.Fatalf("expected content blocks, got plain string %q", expanded)
	}
	if len(blocks) != 2 {
		t.Fatalf("expected text + image blocks, got %d", len(blocks))
	}
	if blocks[0]["type"] != "text" || blocks[0]["text"] != expanded {
		t.Fatalf("text block = %v (expanded %q)", blocks[0], expanded)
	}
	if !strings.Contains(expanded, `<image type="base64" media_type="image/png" path="pic.png" />`) {
		t.Fatalf("missing image placeholder: %q", expanded)
	}
	imageBlock := blocks[1]
	if imageBlock["type"] != "image" {
		t.Fatalf("image block = %v", imageBlock)
	}
	source, _ := imageBlock["source"].(map[string]any)
	if source["type"] != "base64" || source["media_type"] != "image/png" {
		t.Fatalf("source = %v", source)
	}
	if data, _ := source["data"].(string); data == "" {
		t.Fatal("missing base64 data")
	}
}

func TestExpandAtRefsWithImagesBrokenImageSkipped(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "bad.png"), []byte("not a png"), 0o600); err != nil {
		t.Fatal(err)
	}
	expanded, blocks := ExpandAtRefsWithImages("see @bad.png", dir)
	if blocks != nil {
		t.Fatalf("failed image loads must be skipped, got %v", blocks)
	}
	if strings.Contains(expanded, "<image") {
		t.Fatalf("unexpected placeholder: %q", expanded)
	}
}

func TestExpandAtRefsWithImagesLimit(t *testing.T) {
	dir := t.TempDir()
	var refs []string
	for i := 0; i < 12; i++ {
		name := "pic" + string(rune('a'+i)) + ".png"
		writeSmallPNG(t, filepath.Join(dir, name))
		refs = append(refs, "@"+name)
	}
	expanded, blocks := ExpandAtRefsWithImages("many "+strings.Join(refs, " ")+" images", dir)
	if blocks == nil {
		t.Fatal("expected image blocks")
	}
	// 1 text block + at most 10 image blocks.
	imageCount := 0
	for _, block := range blocks {
		if block["type"] == "image" {
			imageCount++
		}
	}
	if imageCount != 10 {
		t.Fatalf("image blocks = %d, want 10", imageCount)
	}
	if !strings.Contains(expanded, "Error: too many images attached (limit 10 per message)") {
		t.Fatalf("missing limit notice: %q", expanded)
	}
	if strings.Count(expanded, "too many images attached") != 1 {
		t.Fatal("limit notice must appear exactly once")
	}
}

func TestAddUserMessageBlocks(t *testing.T) {
	m := NewManager()
	blocks := []map[string]any{{"type": "text", "text": "hi"}}
	m.AddUserMessageBlocks(blocks)
	msgs := m.GetMessages()
	if len(msgs) != 1 || msgs[0].Role != "user" || len(msgs[0].ContentBlocks) != 1 {
		t.Fatalf("message = %+v", msgs[0])
	}
	if msgs[0].ContentText() != "hi" {
		t.Fatalf("ContentText = %q", msgs[0].ContentText())
	}
}

package tools

import (
	"bytes"
	"context"
	"encoding/base64"
	"image"
	"image/color"
	"image/png"
	"math/rand"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writeTestPNG(t *testing.T, path string, width, height int, noise bool) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, width, height))
	rng := rand.New(rand.NewSource(7))
	for y := 0; y < height; y++ {
		for x := 0; x < width; x++ {
			if noise {
				img.Set(x, y, color.RGBA{R: uint8(rng.Intn(256)), G: uint8(rng.Intn(256)), B: uint8(rng.Intn(256)), A: 255})
			} else {
				img.Set(x, y, color.RGBA{R: uint8(x % 256), G: uint8(y % 256), B: 40, A: 255})
			}
		}
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, buf.Bytes(), 0o600); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func TestReadFileImageByExtension(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "pic.png")
	raw := writeTestPNG(t, path, 60, 40, false)

	ctx := WithExecutionContext(context.Background(), ExecutionContext{WorkDir: dir})
	cache := NewFileStateCache()
	read := &ReadFileTool{cache}
	result := read.Execute(ctx, map[string]any{"file_path": "pic.png"})
	if result.IsError {
		t.Fatalf("read failed: %s", result.Output)
	}
	if result.Output != "[Image: image/png]" {
		t.Fatalf("output = %q", result.Output)
	}
	if len(result.ContentBlocks) != 1 {
		t.Fatalf("content blocks = %v", result.ContentBlocks)
	}
	block := result.ContentBlocks[0]
	if block["type"] != "image" {
		t.Fatalf("block type = %v", block["type"])
	}
	source, _ := block["source"].(map[string]any)
	if source["type"] != "base64" || source["media_type"] != "image/png" {
		t.Fatalf("source = %v", source)
	}
	decoded, err := base64.StdEncoding.DecodeString(source["data"].(string))
	if err != nil || !bytes.Equal(decoded, raw) {
		t.Fatalf("passthrough data mismatch: %v", err)
	}
	// The file-state cache must record the image read (EditFile/WriteFile gate).
	if !cache.Has(path) {
		t.Fatalf("expected %s in the file-state cache", path)
	}
}

func TestReadFileImageBypassesTextSizeLimit(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "big.png")
	// Noise PNG comfortably above MaxReadFileBytes (10MB) but valid as an image.
	raw := writeTestPNG(t, path, 2300, 1600, true)
	if len(raw) <= MaxReadFileBytes {
		t.Fatalf("fixture must exceed the text read limit, got %d", len(raw))
	}

	ctx := WithExecutionContext(context.Background(), ExecutionContext{WorkDir: dir})
	read := &ReadFileTool{NewFileStateCache()}
	result := read.Execute(ctx, map[string]any{"file_path": "big.png"})
	if result.IsError {
		t.Fatalf("image read should bypass the text limit: %s", result.Output)
	}
	if !strings.HasPrefix(result.Output, "[Image: image/") {
		t.Fatalf("output = %q", result.Output)
	}
}

func TestReadFileImageBySniffing(t *testing.T) {
	dir := t.TempDir()
	// A PNG whose extension is not an image extension is detected by magic bytes.
	path := filepath.Join(dir, "data.bin")
	writeTestPNG(t, path, 30, 20, false)

	ctx := WithExecutionContext(context.Background(), ExecutionContext{WorkDir: dir})
	read := &ReadFileTool{NewFileStateCache()}
	result := read.Execute(ctx, map[string]any{"file_path": "data.bin"})
	if result.IsError {
		t.Fatalf("sniffed image read failed: %s", result.Output)
	}
	if result.Output != "[Image: image/png]" {
		t.Fatalf("output = %q", result.Output)
	}
}

func TestReadFileImageExtensionWithBadContent(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "corrupt.png")
	if err := os.WriteFile(path, []byte("definitely not a png"), 0o600); err != nil {
		t.Fatal(err)
	}

	ctx := WithExecutionContext(context.Background(), ExecutionContext{WorkDir: dir})
	read := &ReadFileTool{NewFileStateCache()}
	result := read.Execute(ctx, map[string]any{"file_path": "corrupt.png"})
	if !result.IsError {
		t.Fatal("expected error for corrupt image")
	}
	if !strings.Contains(result.Output, "Error reading image corrupt.png:") {
		t.Fatalf("output = %q", result.Output)
	}
}

func TestReadFileTextUnaffected(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "note.txt"), []byte("hello\nworld\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	ctx := WithExecutionContext(context.Background(), ExecutionContext{WorkDir: dir})
	read := &ReadFileTool{NewFileStateCache()}
	result := read.Execute(ctx, map[string]any{"file_path": "note.txt"})
	if result.IsError || !strings.Contains(result.Output, "1\thello") {
		t.Fatalf("text read changed: %+v", result)
	}
	if len(result.ContentBlocks) != 0 {
		t.Fatalf("text read must not produce content blocks: %v", result.ContentBlocks)
	}
}

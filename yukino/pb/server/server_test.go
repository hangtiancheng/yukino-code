// Copyright (c) 2026 hangtiancheng
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

package server

import (
	"testing"

	yukinov1 "github.com/hangtiancheng/yukino-code/yukino/pb/gen/yukino/v1"
)

func textBlock(s string) *yukinov1.ContentBlock {
	return &yukinov1.ContentBlock{Block: &yukinov1.ContentBlock_Text{Text: s}}
}

func imageBlockBase64(mediaType, data string) *yukinov1.ContentBlock {
	return &yukinov1.ContentBlock{Block: &yukinov1.ContentBlock_Image{Image: &yukinov1.ImageBlock{
		Source: &yukinov1.ImageBlock_Base64{Base64: &yukinov1.Base64ImageSource{
			MediaType: mediaType, Data: data,
		}},
	}}}
}

// Text-only turns must return nil blocks so the conversation stores plain string
// content (the pre-multimodal shape), not a one-element text block list.
func TestContentBlocksToGoTextOnly(t *testing.T) {
	text, blocks, err := contentBlocksToGo([]*yukinov1.ContentBlock{textBlock("hello")})
	if err != nil {
		t.Fatal(err)
	}
	if text != "hello" {
		t.Errorf("text = %q, want %q", text, "hello")
	}
	if blocks != nil {
		t.Errorf("text-only turn must return nil blocks, got %v", blocks)
	}
}

// A multimodal turn returns the display text plus content blocks in the exact
// shape the conversation/LLM clients expect: {"type":"text"} and
// {"type":"image","source":{"type":"base64","media_type":...,"data":...}}.
func TestContentBlocksToGoWithImage(t *testing.T) {
	in := []*yukinov1.ContentBlock{
		textBlock("what color?"),
		imageBlockBase64("image/png", "QUJD"),
	}
	text, blocks, err := contentBlocksToGo(in)
	if err != nil {
		t.Fatal(err)
	}
	if text != "what color?" {
		t.Errorf("text = %q, want %q", text, "what color?")
	}
	if len(blocks) != 2 {
		t.Fatalf("want 2 blocks, got %d: %v", len(blocks), blocks)
	}
	if got := blocks[0]["type"]; got != "text" {
		t.Errorf("block[0].type = %v, want text", got)
	}
	if got := blocks[0]["text"]; got != "what color?" {
		t.Errorf("block[0].text = %v, want what color?", got)
	}
	img, ok := blocks[1]["type"].(string)
	if !ok || img != "image" {
		t.Fatalf("block[1].type = %v, want image", blocks[1]["type"])
	}
	src, ok := blocks[1]["source"].(map[string]any)
	if !ok {
		t.Fatalf("block[1].source missing: %v", blocks[1])
	}
	if src["type"] != "base64" || src["media_type"] != "image/png" || src["data"] != "QUJD" {
		t.Errorf("image source = %v, want base64/image/png/QUJD", src)
	}
}

func TestImageBlockToGoURL(t *testing.T) {
	img := &yukinov1.ImageBlock{Source: &yukinov1.ImageBlock_Url{Url: "https://x/y.png"}}
	m, err := imageBlockToGo(img)
	if err != nil {
		t.Fatal(err)
	}
	src, ok := m["source"].(map[string]any)
	if !ok || src["type"] != "url" || src["url"] != "https://x/y.png" {
		t.Errorf("url image = %v", m)
	}
}

func TestImageBlockToGoRejectsIncomplete(t *testing.T) {
	// Missing media_type or data must be rejected, not silently sent.
	if _, err := imageBlockToGo(&yukinov1.ImageBlock{
		Source: &yukinov1.ImageBlock_Base64{Base64: &yukinov1.Base64ImageSource{Data: "x"}},
	}); err == nil {
		t.Error("base64 without media_type must error")
	}
	if _, err := imageBlockToGo(&yukinov1.ImageBlock{}); err == nil {
		t.Error("image without a source must error")
	}
}

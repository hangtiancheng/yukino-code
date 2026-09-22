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

package images

import (
	"bytes"
	"encoding/base64"
	"errors"
	"image"
	"image/color"
	"image/png"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func encodePNG(t *testing.T, img image.Image) []byte {
	t.Helper()
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatalf("encode png: %v", err)
	}
	return buf.Bytes()
}

func solidImage(w, h int, c color.RGBA) *image.RGBA {
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			img.SetRGBA(x, y, c)
		}
	}
	return img
}

// noiseImage builds a deterministic high-entropy image whose PNG/JPEG encodings
// stay large, so compression ladders actually have to shrink it.
func noiseImage(w, h int) *image.RGBA {
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	seed := uint32(1)
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			seed = seed*1664525 + 1013904223
			img.SetRGBA(x, y, color.RGBA{
				R: uint8(seed >> 24),
				G: uint8(seed >> 16),
				B: uint8(seed >> 8),
				A: 255,
			})
		}
	}
	return img
}

func TestAsImageMediaType(t *testing.T) {
	tests := []struct {
		in      string
		want    ImageMediaType
		wantErr bool
	}{
		{in: "image/png", want: MediaTypePNG},
		{in: "image/jpeg", want: MediaTypeJPEG},
		{in: "image/gif", want: MediaTypeGIF},
		{in: "image/webp", want: MediaTypeWebP},
		{in: "image/bmp", wantErr: true},
		{in: "", wantErr: true},
		{in: "IMAGE/PNG", wantErr: true},
	}
	for _, tt := range tests {
		got, err := AsImageMediaType(tt.in)
		if tt.wantErr {
			if err == nil {
				t.Errorf("AsImageMediaType(%q) expected error, got %q", tt.in, got)
			}
			continue
		}
		if err != nil {
			t.Errorf("AsImageMediaType(%q) unexpected error: %v", tt.in, err)
		}
		if got != tt.want {
			t.Errorf("AsImageMediaType(%q) = %q, want %q", tt.in, got, tt.want)
		}
	}
}

func TestGetMediaTypeAndIsImagePath(t *testing.T) {
	tests := []struct {
		path   string
		want   ImageMediaType
		wantOK bool
	}{
		{path: "a.png", want: MediaTypePNG, wantOK: true},
		{path: "dir/A.JPG", want: MediaTypeJPEG, wantOK: true},
		{path: "x.jpeg", want: MediaTypeJPEG, wantOK: true},
		{path: "x.gif", want: MediaTypeGIF, wantOK: true},
		{path: "x.webp", want: MediaTypeWebP, wantOK: true},
		{path: "x.txt", wantOK: false},
		{path: "noext", wantOK: false},
		{path: "png", wantOK: false},
	}
	for _, tt := range tests {
		got, ok := GetMediaType(tt.path)
		if ok != tt.wantOK || (ok && got != tt.want) {
			t.Errorf("GetMediaType(%q) = (%q, %v), want (%q, %v)", tt.path, got, ok, tt.want, tt.wantOK)
		}
		if IsImagePath(tt.path) != tt.wantOK {
			t.Errorf("IsImagePath(%q) = %v, want %v", tt.path, !tt.wantOK, tt.wantOK)
		}
	}
}

func TestSniffMediaType(t *testing.T) {
	tests := []struct {
		name   string
		buf    []byte
		want   ImageMediaType
		wantOK bool
	}{
		{name: "png", buf: []byte{0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a}, want: MediaTypePNG, wantOK: true},
		{name: "png too short", buf: []byte{0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a}, wantOK: false},
		{name: "jpeg", buf: []byte{0xff, 0xd8, 0xff, 0xe0}, want: MediaTypeJPEG, wantOK: true},
		{name: "jpeg minimal", buf: []byte{0xff, 0xd8, 0xff}, want: MediaTypeJPEG, wantOK: true},
		{name: "jpeg too short", buf: []byte{0xff, 0xd8}, wantOK: false},
		{name: "gif", buf: []byte("GIF89a...."), want: MediaTypeGIF, wantOK: true},
		{name: "gif too short", buf: []byte("GIF89"), wantOK: false},
		{name: "webp", buf: []byte("RIFF\x00\x00\x00\x00WEBPVP8 "), want: MediaTypeWebP, wantOK: true},
		{name: "webp too short", buf: []byte("RIFF\x00\x00\x00\x00WEB"), wantOK: false},
		{name: "riff not webp", buf: []byte("RIFF\x00\x00\x00\x00WAVEfmt "), wantOK: false},
		{name: "text", buf: []byte("hello world"), wantOK: false},
		{name: "empty", buf: nil, wantOK: false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, ok := SniffMediaType(tt.buf)
			if ok != tt.wantOK || (ok && got != tt.want) {
				t.Errorf("SniffMediaType() = (%q, %v), want (%q, %v)", got, ok, tt.want, tt.wantOK)
			}
		})
	}
}

func TestMaybeResizePassthrough(t *testing.T) {
	buf := encodePNG(t, solidImage(4, 4, color.RGBA{R: 255, A: 255}))
	// The media type argument must be preserved verbatim on the passthrough path.
	got, err := MaybeResizeAndDownsampleImage(buf, MediaTypeJPEG)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got.MediaType != MediaTypeJPEG {
		t.Errorf("MediaType = %q, want %q", got.MediaType, MediaTypeJPEG)
	}
	if got.ByteLength != len(buf) {
		t.Errorf("ByteLength = %d, want %d", got.ByteLength, len(buf))
	}
	if got.Data != base64.StdEncoding.EncodeToString(buf) {
		t.Errorf("Data is not the base64 of the untouched input")
	}
}

func TestMaybeResizeEmpty(t *testing.T) {
	_, err := MaybeResizeAndDownsampleImage(nil, MediaTypePNG)
	var tooLarge *ImageTooLargeError
	if !errors.As(err, &tooLarge) {
		t.Fatalf("expected ImageTooLargeError, got %v", err)
	}
	if tooLarge.Message != "Image file is empty (0 bytes)" {
		t.Errorf("message = %q", tooLarge.Message)
	}
}

func TestCompressImageKeepsPNGForSolidImage(t *testing.T) {
	buf := encodePNG(t, solidImage(64, 64, color.RGBA{B: 200, A: 255}))
	got, err := compressImage(buf, MediaTypePNG, 2000)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got.MediaType != MediaTypePNG {
		t.Errorf("MediaType = %q, want image/png", got.MediaType)
	}
	if got.ByteLength > 2000 {
		t.Errorf("ByteLength = %d, want <= 2000", got.ByteLength)
	}
}

func TestCompressImageFallsBackToJPEGAndHalves(t *testing.T) {
	buf := encodePNG(t, noiseImage(64, 64))
	if len(buf) <= 1000 {
		t.Fatalf("noise PNG should exceed the tiny test budget, got %d bytes", len(buf))
	}
	got, err := compressImage(buf, MediaTypePNG, 1000)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got.ByteLength > 1000 {
		t.Errorf("ByteLength = %d, want <= 1000", got.ByteLength)
	}
	// Noise at 64x64 cannot fit 1000 bytes as PNG or high-quality JPEG, so the
	// ladder must have halved and re-encoded as JPEG.
	if got.MediaType != MediaTypeJPEG {
		t.Errorf("MediaType = %q, want image/jpeg", got.MediaType)
	}
	raw, err := base64.StdEncoding.DecodeString(got.Data)
	if err != nil {
		t.Fatalf("decode result: %v", err)
	}
	if len(raw) != got.ByteLength {
		t.Errorf("ByteLength = %d, decoded = %d", got.ByteLength, len(raw))
	}
	img, _, err := image.Decode(bytes.NewReader(raw))
	if err != nil {
		t.Fatalf("decode image: %v", err)
	}
	if b := img.Bounds(); b.Dx() >= 64 || b.Dy() >= 64 {
		t.Errorf("dimensions = %dx%d, want halved below 64x64", b.Dx(), b.Dy())
	}
}

func TestCompressImageCapsDimensionsByHalving(t *testing.T) {
	buf := encodePNG(t, solidImage(4096, 4, color.RGBA{G: 128, A: 255}))
	got, err := compressImage(buf, MediaTypePNG, MaxImageBytesPassthrough)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	raw, err := base64.StdEncoding.DecodeString(got.Data)
	if err != nil {
		t.Fatalf("decode result: %v", err)
	}
	img, _, err := image.Decode(bytes.NewReader(raw))
	if err != nil {
		t.Fatalf("decode image: %v", err)
	}
	// 4096 -> 2048 -> 1024: halving lands below the 2000px cap.
	if b := img.Bounds(); b.Dx() > MaxDimensionPx || b.Dy() > MaxDimensionPx {
		t.Errorf("dimensions = %dx%d, want within %dpx cap", b.Dx(), b.Dy(), MaxDimensionPx)
	}
	if b := img.Bounds(); b.Dx() != 1024 {
		t.Errorf("width = %d, want 1024 (two halvings of 4096)", b.Dx())
	}
}

func TestCompressImageUndecodableWebP(t *testing.T) {
	buf := []byte("RIFF\x00\x00\x00\x00WEBPVP8 \x00\x00\x00\x00garbage")
	_, err := compressImage(buf, MediaTypeWebP, 100)
	var tooLarge *ImageTooLargeError
	if !errors.As(err, &tooLarge) {
		t.Fatalf("expected ImageTooLargeError, got %v", err)
	}
	if !strings.Contains(tooLarge.Message, "compression failed") {
		t.Errorf("message = %q, want the TS sharp-failure wording", tooLarge.Message)
	}
}

func TestCompressImageGivesUp(t *testing.T) {
	buf := encodePNG(t, noiseImage(8, 8))
	// A budget no JPEG thumbnail can meet: the ladder must exhaust its attempts.
	_, err := compressImage(buf, MediaTypeJPEG, 10)
	var tooLarge *ImageTooLargeError
	if !errors.As(err, &tooLarge) {
		t.Fatalf("expected ImageTooLargeError, got %v", err)
	}
	if !strings.Contains(tooLarge.Message, "Unable to compress image") {
		t.Errorf("message = %q", tooLarge.Message)
	}
}

func TestHalveImage(t *testing.T) {
	tests := []struct {
		w, h         int
		wantW, wantH int
	}{
		{w: 4, h: 4, wantW: 2, wantH: 2},
		{w: 5, h: 5, wantW: 3, wantH: 3}, // Math.round(n/2) rounds up
		{w: 1, h: 1, wantW: 1, wantH: 1}, // minimum 1
		{w: 2, h: 1, wantW: 1, wantH: 1},
	}
	for _, tt := range tests {
		src := solidImage(tt.w, tt.h, color.RGBA{R: 100, G: 100, B: 100, A: 255})
		dst := halveImage(src)
		b := dst.Bounds()
		if b.Dx() != tt.wantW || b.Dy() != tt.wantH {
			t.Errorf("halveImage(%dx%d) = %dx%d, want %dx%d", tt.w, tt.h, b.Dx(), b.Dy(), tt.wantW, tt.wantH)
		}
		r, g, bl, a := dst.At(0, 0).RGBA()
		if uint8(r>>8) != 100 || uint8(g>>8) != 100 || uint8(bl>>8) != 100 || uint8(a>>8) != 255 {
			t.Errorf("halveImage color = %v %v %v %v, want solid 100/100/100/255", r>>8, g>>8, bl>>8, a>>8)
		}
	}
}

func TestLoadImageAttachment(t *testing.T) {
	dir := t.TempDir()

	pngPath := filepath.Join(dir, "pic.png")
	pngBytes := encodePNG(t, solidImage(8, 8, color.RGBA{R: 10, G: 20, B: 30, A: 255}))
	if err := os.WriteFile(pngPath, pngBytes, 0o644); err != nil {
		t.Fatal(err)
	}
	got, err := LoadImageAttachment(pngPath)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got.MediaType != MediaTypePNG || got.SourcePath != pngPath || got.ByteLength != len(pngBytes) {
		t.Errorf("attachment = %+v", got)
	}
	if got.Data != base64.StdEncoding.EncodeToString(pngBytes) {
		t.Errorf("small PNG must pass through untouched")
	}

	// Image extension but non-image contents: magic bytes must win.
	fakePath := filepath.Join(dir, "fake.png")
	if err := os.WriteFile(fakePath, []byte("definitely not an image"), 0o644); err != nil {
		t.Fatal(err)
	}
	_, err = LoadImageAttachment(fakePath)
	if err == nil || !strings.Contains(err.Error(), "not a supported image format") {
		t.Errorf("fake.png error = %v", err)
	}

	// Directory: not a regular file.
	_, err = LoadImageAttachment(dir)
	if err == nil || !strings.Contains(err.Error(), "Not a file") {
		t.Errorf("directory error = %v", err)
	}

	// Missing file.
	if _, err := LoadImageAttachment(filepath.Join(dir, "missing.png")); err == nil {
		t.Errorf("missing file should error")
	}
}

// minimalWebP is a valid 1x1 lossy WebP (VP8) file.
const minimalWebP = "UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoBAAEAAwA0JaQAA3AA/vuUAAA="

func TestWebPDecoderRegistered(t *testing.T) {
	raw, err := base64.StdEncoding.DecodeString(minimalWebP)
	if err != nil {
		t.Fatal(err)
	}
	img, format, err := image.Decode(bytes.NewReader(raw))
	if err != nil {
		t.Fatalf("webp decode failed (x/image/webp not registered?): %v", err)
	}
	if format != "webp" {
		t.Errorf("format = %q, want webp", format)
	}
	if b := img.Bounds(); b.Dx() != 1 || b.Dy() != 1 {
		t.Errorf("bounds = %v, want 1x1", b)
	}
}

func TestCompressImageReEncodesWebP(t *testing.T) {
	raw, err := base64.StdEncoding.DecodeString(minimalWebP)
	if err != nil {
		t.Fatal(err)
	}
	// A decodable WebP goes through the re-encode ladder (JPEG, since WebP is
	// not PNG-preserved) instead of the sharp-failure branch.
	res, err := compressImage(raw, MediaTypeWebP, 100_000)
	if err != nil {
		t.Fatalf("webp compression failed: %v", err)
	}
	if res.MediaType != MediaTypeJPEG {
		t.Errorf("media type = %q, want image/jpeg", res.MediaType)
	}
}

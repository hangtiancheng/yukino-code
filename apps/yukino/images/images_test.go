package images

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"image"
	"image/color"
	"image/png"
	"math/rand"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func makePNG(t *testing.T, width, height int, noise bool) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, width, height))
	rng := rand.New(rand.NewSource(42))
	for y := 0; y < height; y++ {
		for x := 0; x < width; x++ {
			if noise {
				img.Set(x, y, color.RGBA{R: uint8(rng.Intn(256)), G: uint8(rng.Intn(256)), B: uint8(rng.Intn(256)), A: 255})
			} else {
				img.Set(x, y, color.RGBA{R: uint8(x % 256), G: uint8(y % 256), B: 128, A: 255})
			}
		}
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func TestSniffMediaType(t *testing.T) {
	cases := []struct {
		name string
		buf  []byte
		want ImageMediaType
		ok   bool
	}{
		{"png", append([]byte{0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a}, 0, 0), MediaTypePNG, true},
		{"png too short", []byte{0x89, 0x50, 0x4e, 0x47}, "", false},
		{"jpeg", []byte{0xff, 0xd8, 0xff, 0xe0}, MediaTypeJPEG, true},
		{"jpeg too short", []byte{0xff, 0xd8}, "", false},
		{"gif", []byte("GIF89a..."), MediaTypeGIF, true},
		{"gif too short", []byte("GIF89"), "", false},
		{"webp", append(append([]byte("RIFF"), 0, 0, 0, 0), []byte("WEBP....")...), MediaTypeWebP, true},
		{"webp wrong brand", append(append([]byte("RIFF"), 0, 0, 0, 0), []byte("WAVE....")...), "", false},
		{"text", []byte("hello world, not an image"), "", false},
		{"empty", nil, "", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, ok := SniffMediaType(tc.buf)
			if got != tc.want || ok != tc.ok {
				t.Fatalf("SniffMediaType = %q,%v want %q,%v", got, ok, tc.want, tc.ok)
			}
		})
	}
}

func TestGetMediaTypeAndIsImagePath(t *testing.T) {
	for path, want := range map[string]ImageMediaType{
		"a.png": MediaTypePNG, "b.JPG": MediaTypeJPEG, "c.jpeg": MediaTypeJPEG,
		"d.gif": MediaTypeGIF, "e.webp": MediaTypeWebP,
	} {
		got, ok := GetMediaType(path)
		if !ok || got != want {
			t.Errorf("GetMediaType(%q) = %q,%v want %q,true", path, got, ok, want)
		}
		if !IsImagePath(path) {
			t.Errorf("IsImagePath(%q) = false", path)
		}
	}
	if _, ok := GetMediaType("f.txt"); ok {
		t.Error("GetMediaType(f.txt) should miss")
	}
	if IsImagePath("f.txt") {
		t.Error("IsImagePath(f.txt) should be false")
	}
}

func TestAsImageMediaType(t *testing.T) {
	for _, valid := range []string{"image/png", "image/jpeg", "image/gif", "image/webp"} {
		if got, err := AsImageMediaType(valid); err != nil || string(got) != valid {
			t.Errorf("AsImageMediaType(%q) = %q,%v", valid, got, err)
		}
	}
	if _, err := AsImageMediaType("image/bmp"); err == nil || err.Error() != `Unsupported image media type: "image/bmp"` {
		t.Errorf("AsImageMediaType(image/bmp) err = %v", err)
	}
}

func TestLoadImageAttachmentPassthrough(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "small.png")
	data := makePNG(t, 40, 30, false)
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
	attachment, err := LoadImageAttachment(context.Background(), path)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if attachment.MediaType != MediaTypePNG || attachment.SourcePath != path || attachment.ByteLength != len(data) {
		t.Fatalf("attachment = %+v", attachment)
	}
	decoded, err := base64.StdEncoding.DecodeString(attachment.Data)
	if err != nil || !bytes.Equal(decoded, data) {
		t.Fatalf("data mismatch: %v", err)
	}
}

func TestLoadImageAttachmentErrors(t *testing.T) {
	dir := t.TempDir()

	// Directory, not a file.
	if _, err := LoadImageAttachment(context.Background(), dir); err == nil || err.Error() != "Not a file: "+dir {
		t.Fatalf("expected not-a-file error, got %v", err)
	}

	// Image extension with non-image content.
	textPath := filepath.Join(dir, "fake.png")
	if err := os.WriteFile(textPath, []byte("this is not an image"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadImageAttachment(context.Background(), textPath); err == nil ||
		!strings.Contains(err.Error(), "has an image extension but its contents are not a supported image format") {
		t.Fatalf("expected unsupported-content error, got %v", err)
	}

	// Over the 50MB on-disk admission cap (sparse file).
	bigPath := filepath.Join(dir, "big.png")
	bigFile, err := os.Create(bigPath)
	if err != nil {
		t.Fatal(err)
	}
	if err := bigFile.Truncate(MaxImageInputBytes + 1); err != nil {
		t.Fatal(err)
	}
	bigFile.Close()
	_, err = LoadImageAttachment(context.Background(), bigPath)
	var tooLarge *ImageTooLargeError
	if !errors.As(err, &tooLarge) {
		t.Fatalf("expected ImageTooLargeError, got %v", err)
	}
	if !strings.Contains(tooLarge.Message, "Image file is 50.0MB on disk; files over 50.0MB are not read.") {
		t.Fatalf("message = %q", tooLarge.Message)
	}
}

func TestMaybeResizeEmptyAndPassthrough(t *testing.T) {
	_, err := MaybeResizeAndDownsampleImage(context.Background(), nil, MediaTypePNG)
	var tooLarge *ImageTooLargeError
	if !errors.As(err, &tooLarge) || tooLarge.Message != ImageFileEmptyError {
		t.Fatalf("expected empty-file error, got %v", err)
	}

	data := makePNG(t, 20, 20, false)
	resized, err := MaybeResizeAndDownsampleImage(context.Background(), data, MediaTypePNG)
	if err != nil {
		t.Fatalf("passthrough: %v", err)
	}
	if resized.MediaType != MediaTypePNG || resized.ByteLength != len(data) {
		t.Fatalf("resized = %+v", resized)
	}
}

func TestMaybeResizeCompressesLargeImage(t *testing.T) {
	// Noise PNG well above the passthrough cap forces the compression path.
	data := makePNG(t, 2100, 1400, true)
	if len(data) <= MaxImageBytesPassthrough {
		t.Fatalf("test image must exceed the passthrough cap, got %d", len(data))
	}
	resized, err := MaybeResizeAndDownsampleImage(context.Background(), data, MediaTypePNG)
	if err != nil {
		t.Fatalf("compress: %v", err)
	}
	if resized.ByteLength > MaxImageBytesPassthrough {
		t.Fatalf("compressed size %d exceeds cap", resized.ByteLength)
	}
	decoded, err := base64.StdEncoding.DecodeString(resized.Data)
	if err != nil {
		t.Fatal(err)
	}
	img, _, err := image.Decode(bytes.NewReader(decoded))
	if err != nil {
		t.Fatal(err)
	}
	if img.Bounds().Dx() > MaxDimensionPX || img.Bounds().Dy() > MaxDimensionPX {
		t.Fatalf("dimensions %v exceed cap", img.Bounds())
	}
}

func TestSniffFileMediaType(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "x.png")
	if err := os.WriteFile(path, makePNG(t, 10, 10, false), 0o600); err != nil {
		t.Fatal(err)
	}
	mediaType, ok, err := SniffFileMediaType(context.Background(), path)
	if err != nil || !ok || mediaType != MediaTypePNG {
		t.Fatalf("sniff = %q,%v,%v", mediaType, ok, err)
	}

	textPath := filepath.Join(dir, "y.png")
	if err := os.WriteFile(textPath, []byte("nope"), 0o600); err != nil {
		t.Fatal(err)
	}
	_, ok, err = SniffFileMediaType(context.Background(), textPath)
	if err != nil || ok {
		t.Fatalf("expected miss, got %v,%v", ok, err)
	}

	if _, _, err := SniffFileMediaType(context.Background(), filepath.Join(dir, "missing.png")); err == nil {
		t.Fatal("expected error for missing file")
	}
}

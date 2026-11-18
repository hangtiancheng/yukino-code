package images

import (
	"bytes"
	"context"
	"encoding/base64"
	"image"
	"image/color"
	"image/gif"
	"image/jpeg"
	"testing"

	"golang.org/x/image/bmp"
)

func decodeProcessed(t *testing.T, processed *ProcessedImage) image.Image {
	t.Helper()
	data, err := base64.StdEncoding.DecodeString(processed.Data)
	if err != nil {
		t.Fatal(err)
	}
	if processed.ByteLength != len(data) {
		t.Fatalf("byteLength = %d, decoded = %d", processed.ByteLength, len(data))
	}
	img, _, err := image.Decode(bytes.NewReader(data))
	if err != nil {
		t.Fatal(err)
	}
	if img.Bounds().Dx() != processed.Width || img.Bounds().Dy() != processed.Height {
		t.Fatalf("reported %dx%d, decoded %dx%d", processed.Width, processed.Height, img.Bounds().Dx(), img.Bounds().Dy())
	}
	return img
}

func makeJPEG(t *testing.T, width, height int) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, width, height))
	for y := 0; y < height; y++ {
		for x := 0; x < width; x++ {
			img.Set(x, y, color.RGBA{R: uint8(x % 256), G: uint8(y % 256), B: 90, A: 255})
		}
	}
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, img, &jpeg.Options{Quality: 95}); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func TestProcessImageSmallPNGStaysPNG(t *testing.T) {
	data := makePNG(t, 100, 50, false)
	processed, err := ProcessImage(context.Background(), ImageProcessingRequest{Bytes: data})
	if err != nil {
		t.Fatalf("process: %v", err)
	}
	if processed.MediaType != MediaTypePNG {
		t.Fatalf("mediaType = %s, want png (preservePng)", processed.MediaType)
	}
	if processed.Width != 100 || processed.Height != 50 {
		t.Fatalf("dimensions = %dx%d", processed.Width, processed.Height)
	}
	if processed.ScreenWidth != 100 || processed.ScreenHeight != 50 {
		t.Fatalf("screen = %dx%d", processed.ScreenWidth, processed.ScreenHeight)
	}
	decodeProcessed(t, processed)
}

func TestProcessImageJPEGInputUsesJPEG(t *testing.T) {
	data := makeJPEG(t, 300, 200)
	processed, err := ProcessImage(context.Background(), ImageProcessingRequest{Bytes: data})
	if err != nil {
		t.Fatalf("process: %v", err)
	}
	if processed.MediaType != MediaTypeJPEG {
		t.Fatalf("mediaType = %s, want jpeg", processed.MediaType)
	}
	if processed.Width != 300 || processed.Height != 200 {
		t.Fatalf("dimensions = %dx%d", processed.Width, processed.Height)
	}
}

func TestProcessImageGIFInputPreservesPNG(t *testing.T) {
	img := image.NewPaletted(image.Rect(0, 0, 60, 40), color.Palette{color.RGBA{0, 0, 0, 255}, color.RGBA{255, 255, 255, 255}})
	var buf bytes.Buffer
	if err := gif.Encode(&buf, img, nil); err != nil {
		t.Fatal(err)
	}
	processed, err := ProcessImage(context.Background(), ImageProcessingRequest{Bytes: buf.Bytes()})
	if err != nil {
		t.Fatalf("process: %v", err)
	}
	if processed.MediaType != MediaTypePNG {
		t.Fatalf("mediaType = %s, want png for gif source", processed.MediaType)
	}
}

func TestProcessImageBMPFallsToJPEG(t *testing.T) {
	img := image.NewRGBA(image.Rect(0, 0, 64, 32))
	for x := 0; x < 64; x++ {
		for y := 0; y < 32; y++ {
			img.Set(x, y, color.RGBA{R: uint8(x * 4), G: uint8(y * 8), B: 10, A: 255})
		}
	}
	var buf bytes.Buffer
	if err := bmp.Encode(&buf, img); err != nil {
		t.Fatal(err)
	}
	processed, err := ProcessImage(context.Background(), ImageProcessingRequest{Bytes: buf.Bytes()})
	if err != nil {
		t.Fatalf("process: %v", err)
	}
	if processed.MediaType != MediaTypeJPEG {
		t.Fatalf("mediaType = %s, want jpeg for bmp source", processed.MediaType)
	}
}

func TestProcessImageDownscalesToMaxDimension(t *testing.T) {
	data := makePNG(t, 2100, 1400, true)
	processed, err := ProcessImage(context.Background(), ImageProcessingRequest{Bytes: data})
	if err != nil {
		t.Fatalf("process: %v", err)
	}
	if processed.Width != 2000 {
		t.Fatalf("width = %d, want 2000 (scale by max dimension)", processed.Width)
	}
	wantHeight := 1333 // round(1400 * 2000/2100)
	if processed.Height != wantHeight {
		t.Fatalf("height = %d, want %d", processed.Height, wantHeight)
	}
	if processed.ByteLength > MaxImageBytesPassthrough {
		t.Fatalf("byteLength %d exceeds cap", processed.ByteLength)
	}
}

func TestProcessImageScreenshotResize(t *testing.T) {
	data := makePNG(t, 800, 600, false)
	processed, err := ProcessScreenshot(context.Background(), data, ScreenshotOptions{
		ScreenWidth: 1600, ScreenHeight: 1200,
		MaxWidth: 800, MaxHeight: 600,
		CoordinateScaleX: 1, CoordinateScaleY: 1,
	})
	if err != nil {
		t.Fatalf("screenshot: %v", err)
	}
	// scale = min(1, 800/1600, 600/1200) = 0.5 → target 800x600, matching the
	// image, so no resize happens; the screen fields keep the reported values.
	if processed.MediaType != MediaTypePNG || processed.Width != 800 || processed.Height != 600 {
		t.Fatalf("processed = %+v", processed)
	}
	if processed.ScreenWidth != 1600 || processed.ScreenHeight != 1200 {
		t.Fatalf("screen = %dx%d", processed.ScreenWidth, processed.ScreenHeight)
	}
}

func TestProcessImageScreenshotResizeDown(t *testing.T) {
	data := makePNG(t, 1600, 1200, false)
	processed, err := ProcessScreenshot(context.Background(), data, ScreenshotOptions{
		ScreenWidth: 1600, ScreenHeight: 1200,
		MaxWidth: 800, MaxHeight: 600,
		CoordinateScaleX: 1, CoordinateScaleY: 1,
	})
	if err != nil {
		t.Fatalf("screenshot: %v", err)
	}
	if processed.Width != 800 || processed.Height != 600 {
		t.Fatalf("dimensions = %dx%d, want 800x600", processed.Width, processed.Height)
	}
}

func TestProcessImageScreenshotRegion(t *testing.T) {
	data := makePNG(t, 1000, 1000, false)
	processed, err := ProcessScreenshot(context.Background(), data, ScreenshotOptions{
		ScreenWidth: 1000, ScreenHeight: 1000,
		MaxWidth: 1000, MaxHeight: 1000,
		Region:           []int{100, 100, 200, 250},
		CoordinateScaleX: 1, CoordinateScaleY: 1,
	})
	if err != nil {
		t.Fatalf("screenshot: %v", err)
	}
	if processed.Width != 100 || processed.Height != 150 {
		t.Fatalf("crop dimensions = %dx%d, want 100x150", processed.Width, processed.Height)
	}
	if processed.ScreenWidth != 1000 || processed.ScreenHeight != 1000 {
		t.Fatalf("screen = %dx%d", processed.ScreenWidth, processed.ScreenHeight)
	}
}

func TestProcessImageScreenshotRegionWithCoordinateScale(t *testing.T) {
	// A retina-style screenshot: image is 2x the screen coordinate space.
	data := makePNG(t, 2000, 2000, false)
	processed, err := ProcessScreenshot(context.Background(), data, ScreenshotOptions{
		ScreenWidth: 2000, ScreenHeight: 2000,
		MaxWidth: 2000, MaxHeight: 2000,
		Region:           []int{50, 60, 150, 160},
		CoordinateScaleX: 2, CoordinateScaleY: 2,
	})
	if err != nil {
		t.Fatalf("screenshot: %v", err)
	}
	// x = round(round(50*2) * (2000/2000)) = 100; endX = 300 → width 200.
	// y = round(round(60*2) * 1) = 120; endY = 320 → height 200.
	if processed.Width != 200 || processed.Height != 200 {
		t.Fatalf("crop = %dx%d, want 200x200", processed.Width, processed.Height)
	}
}

func TestProcessImageScreenshotDefaultsToImageSize(t *testing.T) {
	data := makePNG(t, 640, 480, false)
	processed, err := ProcessScreenshot(context.Background(), data, ScreenshotOptions{
		ScreenWidth: 0, ScreenHeight: 0,
		MaxWidth: 320, MaxHeight: 240,
		CoordinateScaleX: 1, CoordinateScaleY: 1,
	})
	if err != nil {
		t.Fatalf("screenshot: %v", err)
	}
	if processed.ScreenWidth != 640 || processed.ScreenHeight != 480 {
		t.Fatalf("screen fallback = %dx%d, want image size", processed.ScreenWidth, processed.ScreenHeight)
	}
	if processed.Width != 320 || processed.Height != 240 {
		t.Fatalf("dimensions = %dx%d, want 320x240", processed.Width, processed.Height)
	}
}

func TestProcessImageAbortedContext(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := ProcessImage(ctx, ImageProcessingRequest{Bytes: makePNG(t, 10, 10, false)}); err == nil || err.Error() != ImageProcessingAbortedError {
		t.Fatalf("expected aborted error, got %v", err)
	}
}

func TestProcessImageInvalidBytes(t *testing.T) {
	if _, err := ProcessImage(context.Background(), ImageProcessingRequest{Bytes: []byte("not an image")}); err == nil {
		t.Fatal("expected decode error")
	}
}

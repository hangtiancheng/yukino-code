// Native image processing, mirroring src/images/worker.ts (serialization,
// timeout, abort) and src/images/image-worker.js (decode, compress, screenshot
// crop/resize). The Node worker thread exists to keep wasm/Jimp off the event
// loop; Go runs the same pipeline natively inside a goroutine behind a
// package-level queue that mirrors the reference's `pending` promise chain.
package images

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"image"
	"image/jpeg"
	"image/png"
	"math"
	"sync"
	"time"

	// Decoders registered for image.Decode, matching Jimp.read's formats.
	_ "image/gif"

	"golang.org/x/image/bmp"
	"golang.org/x/image/draw"
	"golang.org/x/image/tiff"
	"golang.org/x/image/webp"
)

// queue serializes ProcessImage calls like the reference `pending` chain.
var queue sync.Mutex

func abortError(ctx context.Context) error {
	if cause := context.Cause(ctx); cause != nil && cause != context.Canceled {
		return cause
	}
	return errors.New(ImageProcessingAbortedError)
}

// ProcessImage decodes and compresses an image (or applies the screenshot
// pipeline) under the reference's serialization, 120s timeout and abort
// semantics.
func ProcessImage(ctx context.Context, request ImageProcessingRequest) (*ProcessedImage, error) {
	if err := ctx.Err(); err != nil {
		return nil, abortError(ctx)
	}
	queue.Lock()
	defer queue.Unlock()
	if err := ctx.Err(); err != nil {
		return nil, abortError(ctx)
	}

	// Defensive copy, mirroring Uint8Array.from(request.bytes).
	payload := append([]byte(nil), request.Bytes...)

	runCtx, cancel := context.WithTimeout(ctx, ImageWorkerTimeoutMS*time.Millisecond)
	defer cancel()

	type outcome struct {
		processed *ProcessedImage
		err       error
	}
	done := make(chan outcome, 1)
	go func() {
		processed, err := processRequest(runCtx, ImageProcessingRequest{Bytes: payload, Screenshot: request.Screenshot})
		done <- outcome{processed, err}
	}()
	select {
	case result := <-done:
		if result.err != nil && ctx.Err() != nil {
			return nil, abortError(ctx)
		}
		return result.processed, result.err
	case <-runCtx.Done():
		if ctx.Err() != nil {
			return nil, abortError(ctx)
		}
		return nil, errors.New(ImageWorkerTimeoutError)
	}
}

func processRequest(ctx context.Context, request ImageProcessingRequest) (*ProcessedImage, error) {
	img, mime, err := decodeImage(request.Bytes)
	if err != nil {
		return nil, err
	}
	options := request.Screenshot
	if options == nil {
		return compress(ctx, img, mime)
	}

	bounds := img.Bounds()
	screenWidth := options.ScreenWidth
	if screenWidth <= 0 {
		screenWidth = bounds.Dx()
	}
	screenHeight := options.ScreenHeight
	if screenHeight <= 0 {
		screenHeight = bounds.Dy()
	}
	if options.Region != nil {
		if len(options.Region) < 4 {
			return nil, errors.New("Screenshot region requires [left, top, right, bottom].")
		}
		scaleX := float64(bounds.Dx()) / float64(screenWidth)
		scaleY := float64(bounds.Dy()) / float64(screenHeight)
		left, top, right, bottom := options.Region[0], options.Region[1], options.Region[2], options.Region[3]
		x := clampInt(0, bounds.Dx()-1, jsRound(jsRoundFloat(float64(left)*options.CoordinateScaleX)*scaleX))
		y := clampInt(0, bounds.Dy()-1, jsRound(jsRoundFloat(float64(top)*options.CoordinateScaleY)*scaleY))
		endX := max(x+1, clampUpper(bounds.Dx(), jsRound(jsRoundFloat(float64(right)*options.CoordinateScaleX)*scaleX)))
		endY := max(y+1, clampUpper(bounds.Dy(), jsRound(jsRoundFloat(float64(bottom)*options.CoordinateScaleY)*scaleY)))
		img = cropImage(img, x, y, endX-x, endY-y)
	} else {
		scale := math.Min(1, math.Min(float64(options.MaxWidth)/float64(screenWidth), float64(options.MaxHeight)/float64(screenHeight)))
		width := max(1, jsRound(float64(screenWidth)*scale))
		height := max(1, jsRound(float64(screenHeight)*scale))
		if width != img.Bounds().Dx() || height != img.Bounds().Dy() {
			img = resizeImage(img, width, height)
		}
	}

	encoded := encodePNG(img)
	var output *ProcessedImage
	if len(encoded) <= MaxImageBytesPassthrough {
		output = resultOf(encoded, MediaTypePNG, img)
	} else {
		output, err = compress(ctx, img, mime)
		if err != nil {
			return nil, err
		}
	}
	output.ScreenWidth = screenWidth
	output.ScreenHeight = screenHeight
	return output, nil
}

// jsRound mirrors Math.round (half toward +inf) for the positive values used
// by the dimension math.
func jsRound(value float64) int {
	return int(math.Floor(value + 0.5))
}

func jsRoundFloat(value float64) float64 {
	return math.Floor(value + 0.5)
}

func clampInt(lower, upper, value int) int {
	return max(lower, min(upper, value))
}

func clampUpper(upper, value int) int {
	return min(upper, value)
}

func decodeImage(data []byte) (image.Image, string, error) {
	if len(data) >= 3 && data[0] == 0xff && data[1] == 0xd8 && data[2] == 0xff {
		img, err := jpeg.Decode(bytes.NewReader(data))
		if err != nil {
			return nil, "", err
		}
		return img, "image/jpeg", nil
	}
	if len(data) >= 12 && string(data[0:4]) == "RIFF" && string(data[8:12]) == "WEBP" {
		img, err := webp.Decode(bytes.NewReader(data))
		if err != nil {
			return nil, "", err
		}
		return img, "image/webp", nil
	}
	img, format, err := image.Decode(bytes.NewReader(data))
	if err != nil {
		return nil, "", err
	}
	switch format {
	case "png":
		return img, "image/png", nil
	case "gif":
		return img, "image/gif", nil
	case "jpeg":
		return img, "image/jpeg", nil
	case "bmp":
		return img, "image/bmp", nil
	case "tiff":
		return img, "image/tiff", nil
	}
	return img, "image/" + format, nil
}

// compress mirrors the worker's compress(): scale to MaxDimensionPX, prefer
// PNG for png/gif sources, then descending JPEG qualities, halving dimensions
// per attempt, three attempts total.
func compress(ctx context.Context, img image.Image, mime string) (*ProcessedImage, error) {
	bounds := img.Bounds()
	origW, origH := bounds.Dx(), bounds.Dy()
	scale := math.Min(1, math.Min(float64(MaxDimensionPX)/float64(origW), float64(MaxDimensionPX)/float64(origH)))
	width := max(1, jsRound(float64(origW)*scale))
	height := max(1, jsRound(float64(origH)*scale))
	preservePng := mime == "image/png" || mime == "image/gif"

	for attempt := 0; attempt < 3; attempt++ {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		resized := img
		if width != origW || height != origH {
			resized = resizeImage(img, width, height)
		}
		if preservePng {
			encoded := encodePNG(resized)
			if len(encoded) <= MaxImageBytesPassthrough {
				return resultOf(encoded, MediaTypePNG, resized), nil
			}
		}
		for _, quality := range []int{80, 60, 40, 20} {
			encoded := encodeJPEG(resized, quality)
			if len(encoded) <= MaxImageBytesPassthrough {
				return resultOf(encoded, MediaTypeJPEG, resized), nil
			}
		}
		width = max(1, jsRound(float64(width)/2))
		height = max(1, jsRound(float64(height)/2))
	}
	return nil, errors.New("Unable to compress image under the API limit.")
}

func resizeImage(img image.Image, width, height int) image.Image {
	dst := image.NewRGBA(image.Rect(0, 0, width, height))
	draw.ApproxBiLinear.Scale(dst, dst.Bounds(), img, img.Bounds(), draw.Over, nil)
	return dst
}

func cropImage(img image.Image, x, y, width, height int) image.Image {
	source := image.Rect(x, y, x+width, y+height)
	dst := image.NewRGBA(image.Rect(0, 0, width, height))
	draw.Src.Draw(dst, dst.Bounds(), img, source.Min)
	return dst
}

func encodePNG(img image.Image) []byte {
	var buf bytes.Buffer
	encoder := png.Encoder{CompressionLevel: png.BestCompression}
	if err := encoder.Encode(&buf, img); err != nil {
		return nil
	}
	return buf.Bytes()
}

func encodeJPEG(img image.Image, quality int) []byte {
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, img, &jpeg.Options{Quality: quality}); err != nil {
		return nil
	}
	return buf.Bytes()
}

func resultOf(data []byte, mediaType ImageMediaType, img image.Image) *ProcessedImage {
	bounds := img.Bounds()
	return &ProcessedImage{
		Data:         base64.StdEncoding.EncodeToString(data),
		MediaType:    mediaType,
		ByteLength:   len(data),
		Width:        bounds.Dx(),
		Height:       bounds.Dy(),
		ScreenWidth:  bounds.Dx(),
		ScreenHeight: bounds.Dy(),
	}
}

// keep bmp/tiff registrations referenced for image.Decode.
var (
	_ = bmp.Decode
	_ = tiff.Decode
)

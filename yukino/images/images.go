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

// Package images is the Go port of the TypeScript library's src/images module:
// media-type helpers, magic-byte sniffing, and the resize/downsample pipeline
// that fits image attachments under the provider API limit.
//
// Differences from the TS version (which uses sharp):
//   - Resizing uses repeated 2x2-box halving instead of sharp's exact
//     aspect-preserving resize to 2000px, so oversized images land at the
//     nearest halved size below the cap.
//   - PNG re-encoding uses the stdlib encoder at best compression; sharp's
//     palette mode is unavailable, so re-encoded PNGs may be larger.
//   - WebP decoding comes from golang.org/x/image/webp (decode-only); an
//     oversized WebP is re-encoded to PNG/JPEG like the TS version. Corrupt
//     WebP input fails with ImageTooLargeError (the TS sharp-failure branch).
//   - Animated GIFs normalize to their first frame, same as the TS version.
package images

import (
	"bytes"
	"encoding/base64"
	"fmt"
	"image"
	"image/color"
	_ "image/gif"
	"image/jpeg"
	"image/png"
	"math/big"
	"os"
	"path/filepath"
	"strings"

	// WebP decoding (decode-only; there is no stdlib or x/image encoder).
	_ "golang.org/x/image/webp"

	"github.com/hangtiancheng/yukino-code/yukino/logger"
	"github.com/hangtiancheng/yukino-code/yukino/utils"
)

// log mirrors the TS module-scoped child logger
// (createChildLogger({module:"images"})).
var log = logger.CreateChildLogger("images")

// ImageMediaType mirrors the TS ImageMediaType union.
type ImageMediaType string

const (
	MediaTypePNG  ImageMediaType = "image/png"
	MediaTypeJPEG ImageMediaType = "image/jpeg"
	MediaTypeGIF  ImageMediaType = "image/gif"
	MediaTypeWebP ImageMediaType = "image/webp"
)

// AsImageMediaType mirrors the TS asImageMediaType: it validates an arbitrary
// string against the supported union and errors on anything else.
func AsImageMediaType(t string) (ImageMediaType, error) {
	switch ImageMediaType(t) {
	case MediaTypePNG, MediaTypeJPEG, MediaTypeGIF, MediaTypeWebP:
		return ImageMediaType(t), nil
	}
	return "", fmt.Errorf("Unsupported image media type: %q", t)
}

// Hard limit is 5MB on the base64-encoded payload. base64 inflates by 4/3, so
// the raw-byte target that always fits is 5MB * 3/4 = 3.75MB.
const (
	MaxImageBytes            = 5 * 1024 * 1024
	MaxImageBytesPassthrough = MaxImageBytes * 3 / 4
	MaxDimensionPx           = 2000
	// Cap images per user message to stay well under provider block limits.
	MaxImagesPerMessage = 10
)

// ImageTooLargeError mirrors the TS ImageTooLargeError class; callers use it to
// decide how to degrade.
type ImageTooLargeError struct {
	Message string
}

func (e *ImageTooLargeError) Error() string {
	return e.Message
}

// ImageAttachment mirrors the TS ImageAttachment interface.
type ImageAttachment struct {
	MediaType ImageMediaType
	// Raw base64 payload without a data: URL prefix.
	Data string
	// Original file path, used for UI labels and session provenance.
	SourcePath string
	// Decoded byte length of Data.
	ByteLength int
}

// ResizedImage mirrors the TS ResizedImage type (ImageAttachment without
// sourcePath).
type ResizedImage struct {
	MediaType  ImageMediaType
	Data       string
	ByteLength int
}

var extMediaTypes = map[string]ImageMediaType{
	".png":  MediaTypePNG,
	".jpg":  MediaTypeJPEG,
	".jpeg": MediaTypeJPEG,
	".gif":  MediaTypeGIF,
	".webp": MediaTypeWebP,
}

// GetMediaType mirrors the TS getMediaType: extension-based lookup, null (false)
// for anything unrecognized.
func GetMediaType(path string) (ImageMediaType, bool) {
	mt, ok := extMediaTypes[strings.ToLower(filepath.Ext(path))]
	return mt, ok
}

// IsImagePath mirrors the TS isImagePath.
func IsImagePath(path string) bool {
	_, ok := GetMediaType(path)
	return ok
}

// SniffMediaType detects the real format from magic bytes, mirroring the TS
// sniffMediaType including its length guards. It returns false when the buffer
// is not a recognized image — callers should reject rather than trust the file
// extension.
func SniffMediaType(buf []byte) (ImageMediaType, bool) {
	if len(buf) >= 8 && buf[0] == 0x89 && buf[1] == 0x50 && buf[2] == 0x4e && buf[3] == 0x47 {
		return MediaTypePNG, true
	}
	if len(buf) >= 3 && buf[0] == 0xff && buf[1] == 0xd8 && buf[2] == 0xff {
		return MediaTypeJPEG, true
	}
	if len(buf) >= 6 && buf[0] == 0x47 && buf[1] == 0x49 && buf[2] == 0x46 {
		return MediaTypeGIF, true
	}
	if len(buf) >= 12 &&
		buf[0] == 0x52 && buf[1] == 0x49 && buf[2] == 0x46 && buf[3] == 0x46 &&
		buf[8] == 0x57 && buf[9] == 0x45 && buf[10] == 0x42 && buf[11] == 0x50 {
		return MediaTypeWebP, true
	}
	return "", false
}

// LoadImageAttachment reads an image file, validates its real format via magic
// bytes, and compresses it to fit API limits. It errors with context on any
// failure (the caller decides how to degrade), mirroring the TS
// loadImageAttachment.
func LoadImageAttachment(absPath string) (*ImageAttachment, error) {
	st, err := os.Stat(absPath)
	if err != nil {
		return nil, err
	}
	if !st.Mode().IsRegular() {
		return nil, fmt.Errorf("Not a file: %s", absPath)
	}
	buf, err := os.ReadFile(absPath)
	if err != nil {
		return nil, err
	}

	sniffed, ok := SniffMediaType(buf)
	if !ok {
		return nil, fmt.Errorf(
			"File %s has an image extension but its contents are not a supported image format (png/jpeg/gif/webp)", absPath)
	}
	// Magic bytes win over the extension when they disagree.
	resized, err := MaybeResizeAndDownsampleImage(buf, sniffed)
	if err != nil {
		return nil, err
	}
	return &ImageAttachment{
		MediaType:  resized.MediaType,
		Data:       resized.Data,
		SourcePath: absPath,
		ByteLength: resized.ByteLength,
	}, nil
}

func toResult(buf []byte, mediaType ImageMediaType) *ResizedImage {
	return &ResizedImage{
		MediaType:  mediaType,
		Data:       base64.StdEncoding.EncodeToString(buf),
		ByteLength: len(buf),
	}
}

// formatMB mirrors `(bytes / (1024*1024)).toFixed(1) + "MB"`. ECMA-262's
// toFixed picks the larger of two equidistant n, so an exact .5 tie rounds up
// — Go's %.1f would round it to even instead. The arithmetic is done in exact
// rationals so the tie is decided on the true binary value, like toFixed.
func formatMB(n float64) string {
	r := new(big.Rat).SetFloat64(n)
	if r == nil {
		// NaN/Inf: unreachable from byte lengths, keep %f's rendering.
		return fmt.Sprintf("%.1fMB", n/(1024*1024))
	}
	r.Quo(r, big.NewRat(1024*1024, 1))
	return utils.RatFixed1(r) + "MB"
}

// MaybeResizeAndDownsampleImage resizes/compresses an image buffer so its
// base64 encoding fits the API limit, mirroring the TS
// maybeResizeAndDownsampleImage:
//  1. <=3.75MB raw passes through untouched (no decode happens).
//  2. Otherwise: cap dimensions at 2000px (by halving), keep PNG when possible
//     (best compression), then walk the JPEG quality ladder 80/60/40/20, then
//     halve dimensions and retry (max twice).
//
// GIF/WebP are re-encoded to PNG/JPEG only when they need compression, which
// also normalizes animated GIFs to their first frame.
func MaybeResizeAndDownsampleImage(buf []byte, mediaType ImageMediaType) (*ResizedImage, error) {
	if len(buf) == 0 {
		return nil, &ImageTooLargeError{Message: "Image file is empty (0 bytes)"}
	}
	if len(buf) <= MaxImageBytesPassthrough {
		return toResult(buf, mediaType), nil
	}
	return compressImage(buf, mediaType, MaxImageBytesPassthrough)
}

// compressionFailedError is the TS ImageTooLargeError thrown when decoding or
// encoding fails (TS: the sharp catch's `…and compression failed…`).
func compressionFailedError(buf []byte) error {
	return &ImageTooLargeError{Message: fmt.Sprintf(
		"Image is %s raw (%s base64-encoded, API limit %s) and compression failed. Please provide a smaller image.",
		formatMB(float64(len(buf))), formatMB(float64(len(buf))*4/3), formatMB(MaxImageBytes))}
}

// compressImage is the TS compressWithSharp counterpart with `budget` in place
// of the hardcoded passthrough target so tests can exercise it with small
// images. Decode failures take the same branch as the TS sharp-failure catch:
// the raw size already exceeds the passthrough target, so the base64 form
// necessarily exceeds the API limit — there is no valid passthrough.
func compressImage(buf []byte, mediaType ImageMediaType, budget int) (*ResizedImage, error) {
	img, _, err := image.Decode(bytes.NewReader(buf))
	if err != nil {
		// TS: log.warn({err}, "sharp compression failed") then throw.
		log.Warn("sharp compression failed", "err", err)
		return nil, compressionFailedError(buf)
	}

	// Cap dimensions at MaxDimensionPx. The TS version resizes to exactly
	// 2000px preserving aspect; the stdlib port halves until within the cap.
	base := img
	for b := img.Bounds(); b.Dx() > MaxDimensionPx || b.Dy() > MaxDimensionPx; {
		img = halveImage(img)
		b = img.Bounds()
	}
	startWidth := img.Bounds().Dx()
	startHeight := img.Bounds().Dy()

	preservePNG := mediaType == MediaTypePNG || mediaType == MediaTypeGIF

	// Halve dimensions and retry the whole ladder at most twice (3 attempts).
	// Each attempt re-derives the image from the original buffer, mirroring the
	// TS `sharp(buf)`-per-attempt comment: reusing an already-halved image
	// compounds the quality loss across rounds.
	width, height := startWidth, startHeight
	for attempt := 0; attempt < 3; attempt++ {
		img = downscaleToFit(base, width, height)
		if preservePNG {
			var pngBuf bytes.Buffer
			if err := (&png.Encoder{CompressionLevel: png.BestCompression}).Encode(&pngBuf, img); err != nil {
				// TS lets a sharp encode throw: the whole compression fails
				// rather than silently trying the next quality rung.
				log.Warn("sharp compression failed", "err", err)
				return nil, compressionFailedError(buf)
			} else if pngBuf.Len() <= budget {
				return toResult(pngBuf.Bytes(), MediaTypePNG), nil
			}
		}
		for _, quality := range []int{80, 60, 40, 20} {
			var jpegBuf bytes.Buffer
			if err := jpeg.Encode(&jpegBuf, img, &jpeg.Options{Quality: quality}); err != nil {
				log.Warn("sharp compression failed", "err", err)
				return nil, compressionFailedError(buf)
			} else if jpegBuf.Len() <= budget {
				return toResult(jpegBuf.Bytes(), MediaTypeJPEG), nil
			}
		}
		width = max(1, width/2)
		height = max(1, height/2)
	}

	return nil, &ImageTooLargeError{Message: fmt.Sprintf(
		"Unable to compress image (%s raw) under the %s API limit. Please provide a smaller image.",
		formatMB(float64(len(buf))), formatMB(MaxImageBytes))}
}

// downscaleToFit re-derives a target-sized image from the original source by
// repeated box halving, so each quality-ladder attempt starts from the same
// pixels instead of the previous attempt's already-degraded output.
func downscaleToFit(src image.Image, width, height int) image.Image {
	img := src
	for b := img.Bounds(); b.Dx() > width || b.Dy() > height; {
		img = halveImage(img)
		b = img.Bounds()
	}
	return img
}

// halveImage returns img downscaled to half width and half height (rounded up,
// minimum 1, matching TS Math.max(1, Math.round(n / 2))) using 2x2 box
// averaging with edge clamping.
func halveImage(src image.Image) image.Image {
	sb := src.Bounds()
	w := (sb.Dx() + 1) / 2
	h := (sb.Dy() + 1) / 2
	if w < 1 {
		w = 1
	}
	if h < 1 {
		h = 1
	}
	dst := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			var rSum, gSum, bSum, aSum, n uint32
			for dy := 0; dy < 2; dy++ {
				sy := sb.Min.Y + y*2 + dy
				if sy >= sb.Max.Y {
					continue
				}
				for dx := 0; dx < 2; dx++ {
					sx := sb.Min.X + x*2 + dx
					if sx >= sb.Max.X {
						continue
					}
					r, g, b, a := src.At(sx, sy).RGBA()
					rSum += r
					gSum += g
					bSum += b
					aSum += a
					n++
				}
			}
			dst.SetRGBA(x, y, color.RGBA{
				R: uint8((rSum / n) >> 8),
				G: uint8((gSum / n) >> 8),
				B: uint8((bSum / n) >> 8),
				A: uint8((aSum / n) >> 8),
			})
		}
	}
	return dst
}

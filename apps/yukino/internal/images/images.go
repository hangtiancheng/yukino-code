package images

import (
	"context"
	"encoding/base64"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/yukino-js/yukino/yukino/internal/logger"
)

var log = logger.CreateChildLogger("images")

// ImageTooLargeError mirrors the reference class of the same name; callers
// distinguish it with errors.As.
type ImageTooLargeError struct {
	Message string
}

func (e *ImageTooLargeError) Error() string { return e.Message }

// ResizedImage mirrors the reference ResizedImage (ImageAttachment without
// sourcePath).
type ResizedImage struct {
	MediaType  ImageMediaType
	Data       string
	ByteLength int
}

func AsImageMediaType(mediaType string) (ImageMediaType, error) {
	switch ImageMediaType(mediaType) {
	case MediaTypePNG, MediaTypeJPEG, MediaTypeGIF, MediaTypeWebP:
		return ImageMediaType(mediaType), nil
	}
	return "", fmt.Errorf("Unsupported image media type: %q", mediaType)
}

func GetMediaType(path string) (ImageMediaType, bool) {
	mediaType, ok := MediaTypeByExtension[strings.ToLower(filepath.Ext(path))]
	return mediaType, ok
}

func IsImagePath(path string) bool {
	_, ok := GetMediaType(path)
	return ok
}

// SniffMediaType detects the real format from magic bytes. It reports false
// when the buffer is not a recognized image — callers should reject rather
// than trust the file extension.
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
	if len(buf) >= 12 && buf[0] == 0x52 && buf[1] == 0x49 && buf[2] == 0x46 && buf[3] == 0x46 &&
		buf[8] == 0x57 && buf[9] == 0x45 && buf[10] == 0x42 && buf[11] == 0x50 {
		return MediaTypeWebP, true
	}
	return "", false
}

func SniffFileMediaType(ctx context.Context, absPath string) (ImageMediaType, bool, error) {
	if err := ctx.Err(); err != nil {
		return "", false, err
	}
	file, err := os.Open(absPath)
	if err != nil {
		return "", false, err
	}
	defer file.Close()
	if err := ctx.Err(); err != nil {
		return "", false, err
	}
	header := make([]byte, 12)
	read, err := file.Read(header)
	if err != nil && !(err == io.EOF && read > 0) {
		return "", false, err
	}
	if err := ctx.Err(); err != nil {
		return "", false, err
	}
	mediaType, ok := SniffMediaType(header[:read])
	return mediaType, ok, nil
}

// LoadImageAttachment reads an image file, validates its real format via magic
// bytes, and compresses it to fit API limits.
func LoadImageAttachment(ctx context.Context, absPath string) (*ImageAttachment, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	info, err := os.Stat(absPath)
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() {
		return nil, fmt.Errorf("Not a file: %s", absPath)
	}
	if info.Size() > MaxImageInputBytes {
		return nil, &ImageTooLargeError{Message: fmt.Sprintf(
			"Image file is %s on disk; files over %s are not read. Please provide a smaller image.",
			formatMB(info.Size()), formatMB(MaxImageInputBytes))}
	}
	buf, err := os.ReadFile(absPath)
	if err != nil {
		return nil, err
	}
	sniffed, ok := SniffMediaType(buf)
	if !ok {
		return nil, fmt.Errorf("File %s has an image extension but its contents are not a supported image format (png/jpeg/gif/webp)", absPath)
	}
	// Magic bytes win over the extension when they disagree.
	resized, err := MaybeResizeAndDownsampleImage(ctx, buf, sniffed)
	if err != nil {
		return nil, err
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	return &ImageAttachment{
		MediaType:  resized.MediaType,
		Data:       resized.Data,
		SourcePath: absPath,
		ByteLength: resized.ByteLength,
	}, nil
}

func formatMB(bytes int64) string {
	return fmt.Sprintf("%.1fMB", float64(bytes)/(1024*1024))
}

func MaybeResizeAndDownsampleImage(ctx context.Context, buf []byte, mediaType ImageMediaType) (*ResizedImage, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if len(buf) == 0 {
		return nil, &ImageTooLargeError{Message: ImageFileEmptyError}
	}
	if len(buf) <= MaxImageBytesPassthrough {
		return &ResizedImage{
			Data:       base64.StdEncoding.EncodeToString(buf),
			MediaType:  mediaType,
			ByteLength: len(buf),
		}, nil
	}
	processed, err := ProcessImage(ctx, ImageProcessingRequest{Bytes: buf})
	if err != nil {
		if ctxErr := ctx.Err(); ctxErr != nil {
			return nil, ctxErr
		}
		log.Warn(map[string]any{"err": err}, "image compression failed")
		return nil, &ImageTooLargeError{Message: fmt.Sprintf(
			"Image is %s raw (%s base64-encoded, API limit %s) and compression failed. Please provide a smaller image.",
			formatMB(int64(len(buf))), formatMB(int64(float64(len(buf))*4/3)), formatMB(MaxImageBytes))}
	}
	return &ResizedImage{
		Data:       processed.Data,
		MediaType:  processed.MediaType,
		ByteLength: processed.ByteLength,
	}, nil
}

func ProcessScreenshot(ctx context.Context, bytes []byte, options ScreenshotOptions) (*ProcessedImage, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	return ProcessImage(ctx, ImageProcessingRequest{Bytes: bytes, Screenshot: &options})
}

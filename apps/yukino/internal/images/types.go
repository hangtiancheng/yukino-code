package images

type ImageMediaType string

const (
	MediaTypePNG  ImageMediaType = "image/png"
	MediaTypeJPEG ImageMediaType = "image/jpeg"
	MediaTypeGIF  ImageMediaType = "image/gif"
	MediaTypeWebP ImageMediaType = "image/webp"
)

// ScreenshotOptions mirrors the reference ScreenshotOptions.
type ScreenshotOptions struct {
	ScreenWidth      int
	ScreenHeight     int
	MaxWidth         int
	MaxHeight        int
	Region           []int
	CoordinateScaleX float64
	CoordinateScaleY float64
}

// ImageProcessingRequest mirrors the reference ImageProcessingRequest.
type ImageProcessingRequest struct {
	Bytes      []byte
	Screenshot *ScreenshotOptions
}

// ProcessedImage mirrors the reference ProcessedImageSchema.
type ProcessedImage struct {
	// Base64 payload without a data: URL prefix.
	Data         string
	MediaType    ImageMediaType
	ByteLength   int
	Width        int
	Height       int
	ScreenWidth  int
	ScreenHeight int
}

// ImageAttachment mirrors the reference ImageAttachment interface.
type ImageAttachment struct {
	MediaType ImageMediaType
	// Raw base64 payload without a data: URL prefix.
	Data string
	// Absolute path of the source image file.
	SourcePath string
	// Decoded byte length of Data.
	ByteLength int
}

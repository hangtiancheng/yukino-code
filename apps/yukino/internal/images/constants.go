package images

// Hard limit is 5MB on the base64-encoded payload. base64 inflates by 4/3, so
// the raw-byte target that always fits is 5MB * 3/4 = 3.75MB.
const (
	MaxImageBytes            = 5 * 1024 * 1024
	MaxImageBytesPassthrough = MaxImageBytes * 3 / 4
	// On-disk admission cap for LoadImageAttachment (pre-read memory bound).
	MaxImageInputBytes = 50 * 1024 * 1024

	MaxDimensionPX = 2000

	ImageWorkerTimeoutMS        = 120_000
	ImageWorkerTimeoutError     = "Image processing timed out."
	ImageWorkerExitError        = "Image processing worker exited without a result."
	ImageProcessingAbortedError = "Image processing was aborted."
	ImageFileEmptyError         = "Image file is empty (0 bytes)"

	// Cap images per user message to stay well under provider block limits.
	MaxImagesPerMessage = 10

	ClipboardTimeoutMS      = 5_000
	MaxClipboardImageBytes  = 32 * 1024 * 1024
	MaxStderrBytes          = 16 * 1024
	NoImageMessage          = "The clipboard does not contain an image."
	ClipboardNotPNGError    = "Clipboard data is not a PNG image."
	ClipboardNoSessionError = "No Wayland or X11 session found (WAYLAND_DISPLAY and DISPLAY are unset)."
)

var PNGSignature = []byte{0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a}

var MediaTypeByExtension = map[string]ImageMediaType{
	".png":  MediaTypePNG,
	".jpg":  MediaTypeJPEG,
	".jpeg": MediaTypeJPEG,
	".gif":  MediaTypeGIF,
	".webp": MediaTypeWebP,
}

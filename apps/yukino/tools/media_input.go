package tools

import (
	"bytes"
	"encoding/base64"
	"errors"
	"fmt"
	"image"
	"image/color"
	_ "image/gif"
	"image/jpeg"
	_ "image/png"
	"os"
	"path/filepath"
	"strings"
)

const inputImageRawBudget = 50 * 1024

func prepareInputImage(in, workDir string) (string, error) {
	if in == "" {
		return "", errors.New("empty input image")
	}
	low := strings.ToLower(in)
	if strings.HasPrefix(low, "http://") || strings.HasPrefix(low, "https://") {
		return in, nil
	}

	var raw []byte
	switch {
	case strings.HasPrefix(low, "data:"):
		b, err := decodeDataURI(in)
		if err != nil {
			return "", err
		}
		raw = b
	default:
		path := in
		if !filepath.IsAbs(path) && workDir != "" {
			path = filepath.Join(workDir, path)
		}
		b, err := os.ReadFile(path)
		if err != nil {
			return "", fmt.Errorf("read input image %q: %w", in, err)
		}
		raw = b
	}

	img, _, err := image.Decode(bytes.NewReader(raw))
	if err != nil {
		return "", fmt.Errorf("decode input image: %w", err)
	}

	jpegBytes, err := shrinkToBudget(img, inputImageRawBudget)
	if err != nil {
		return "", err
	}
	return "data:image/jpeg;base64," + base64.StdEncoding.EncodeToString(jpegBytes), nil
}

func shrinkToBudget(img image.Image, budget int) ([]byte, error) {
	qualities := []int{82, 65, 45, 28}
	for {
		for _, q := range qualities {
			buf := &bytes.Buffer{}
			if err := jpeg.Encode(buf, img, &jpeg.Options{Quality: q}); err != nil {
				return nil, fmt.Errorf("encode jpeg: %w", err)
			}
			if buf.Len() <= budget {
				return buf.Bytes(), nil
			}
		}
		b := img.Bounds()
		w, h := b.Dx()/2, b.Dy()/2
		if w < 8 || h < 8 {
			return nil, fmt.Errorf("cannot shrink image under %d bytes", budget)
		}
		img = halve(img)
	}
}

func halve(src image.Image) image.Image {
	sb := src.Bounds()
	w, h := sb.Dx()/2, sb.Dy()/2
	dst := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			sx, sy := sb.Min.X+x*2, sb.Min.Y+y*2
			r1, g1, b1, a1 := src.At(sx, sy).RGBA()
			r2, g2, b2, a2 := src.At(sx+1, sy).RGBA()
			r3, g3, b3, a3 := src.At(sx, sy+1).RGBA()
			r4, g4, b4, a4 := src.At(sx+1, sy+1).RGBA()
			dst.SetRGBA(x, y, color.RGBA{
				R: uint8((r1 + r2 + r3 + r4) >> 10),
				G: uint8((g1 + g2 + g3 + g4) >> 10),
				B: uint8((b1 + b2 + b3 + b4) >> 10),
				A: uint8((a1 + a2 + a3 + a4) >> 10),
			})
		}
	}
	return dst
}

func validateVideoInputURL(in string) error {
	if in == "" {
		return errors.New("empty input image")
	}
	low := strings.ToLower(in)
	if strings.HasPrefix(low, "http://") || strings.HasPrefix(low, "https://") {
		return nil
	}
	if strings.HasPrefix(low, "data:") {
		return fmt.Errorf("video input_images must be public http(s) URLs; data URIs are not accepted by the upstream API")
	}
	return fmt.Errorf("video input_images must be public http(s) URLs (got %q); upload the image to a reachable URL first", in)
}

func decodeDataURI(s string) ([]byte, error) {
	comma := strings.IndexByte(s, ',')
	if comma < 0 {
		return nil, errors.New("data URI missing comma separator")
	}
	header := s[:comma]
	if !strings.Contains(header, ";base64") {
		return nil, errors.New("data URI must be base64-encoded")
	}
	return base64.StdEncoding.DecodeString(s[comma+1:])
}

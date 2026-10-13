package docs

import (
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"math"
)

// NormalizeVector returns a unit-length copy. A zero vector is returned unchanged.
func NormalizeVector(values []float64) []float32 {
	out := make([]float32, len(values))
	var sum float64
	for i, value := range values {
		out[i] = float32(value)
		sum += value * value
	}
	norm := math.Sqrt(sum)
	if norm > 0 {
		for i := range out {
			out[i] = float32(float64(out[i]) / norm)
		}
	}
	return out
}

// VectorToBlob encodes a vector as little-endian float32 bytes.
func VectorToBlob(values []float32) []byte {
	buf := make([]byte, 4*len(values))
	for i, value := range values {
		binary.LittleEndian.PutUint32(buf[i*4:], math.Float32bits(value))
	}
	return buf
}

// BlobToVector decodes a little-endian float32 blob. A short blob yields a
// zero-padded vector of dim elements.
func BlobToVector(blob []byte, dim int) []float32 {
	out := make([]float32, dim)
	for i := 0; i < dim && (i+1)*4 <= len(blob); i++ {
		out[i] = math.Float32frombits(binary.LittleEndian.Uint32(blob[i*4:]))
	}
	return out
}

// SHA256 returns the hex digest of text.
func SHA256(text string) string {
	sum := sha256.Sum256([]byte(text))
	return hex.EncodeToString(sum[:])
}

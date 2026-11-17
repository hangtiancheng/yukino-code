package utils

import (
	"crypto/rand"
	"encoding/hex"
	"strconv"
	"time"
)

// GenerateSlug builds a timestamp+entropy slug, mirroring generateSlug.
func GenerateSlug() string {
	timestamp := strconv.FormatInt(time.Now().UnixMilli(), 36)
	buf := make([]byte, 6)
	if _, err := rand.Read(buf); err != nil {
		panic(err)
	}
	return timestamp + "-" + hex.EncodeToString(buf)
}

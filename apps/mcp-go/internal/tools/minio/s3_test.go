package minio

import (
	"testing"
	"time"
)

func TestSignHeaderWhitespace(t *testing.T) {
	opts := SignOptions{
		Method: "GET", Endpoint: "http://localhost:9000", CanonicalURI: "/data/file",
		Credentials: S3Credentials{AccessKey: "a", SecretKey: "b", Region: "us-east-1"},
		Now:         time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC),
		Headers:     map[string]string{"x-amz-meta-title": "  a   b\tc  "},
	}
	a := SignRequest(opts)
	opts.Headers["x-amz-meta-title"] = "a b c"
	b := SignRequest(opts)
	if a.Headers["authorization"] != b.Headers["authorization"] {
		t.Fatal("equivalent whitespace produced different signatures")
	}
	if a.Headers["x-amz-meta-title"] != "a b c" {
		t.Fatalf("header = %q", a.Headers["x-amz-meta-title"])
	}
}

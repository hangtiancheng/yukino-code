// Package minio exposes the minio_tool: an unrestricted S3/MinIO REST client
// that signs requests with AWS Signature V4 (path-style).
package minio

import (
	"context"
	"encoding/base64"
	"errors"
	"os"
	"regexp"
	"strings"
	"unicode/utf8"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/hangtiancheng/yukino-code/apps/mcp-go/internal/config"
	"github.com/hangtiancheng/yukino-code/apps/mcp-go/internal/tools"
	"github.com/hangtiancheng/yukino-code/apps/mcp-go/internal/tools/operations"
)

const (
	defaultTimeout = 30_000
	defaultMaxByte = 1_000_000
)

var textSubtypeRE = regexp.MustCompile(`(?i)(^|/)(xml|json|javascript|html|x-www-form-urlencoded)([;+]|$)`)

// Input is the minio_tool argument schema.
type Input struct {
	Endpoint        string            `json:"endpoint,omitempty" jsonschema:"S3 endpoint origin override, e.g. http://localhost:9000."`
	Region          string            `json:"region,omitempty" jsonschema:"Signing region override (default us-east-1)."`
	Method          string            `json:"method,omitempty" jsonschema:"HTTP method: GET, PUT, POST, DELETE, HEAD or PATCH. Defaults to GET."`
	Bucket          string            `json:"bucket,omitempty" jsonschema:"Target bucket. Omit for the service-level ListBuckets call."`
	Key             string            `json:"key,omitempty" jsonschema:"Object key, including any '/' path segments."`
	Query           map[string]any    `json:"query,omitempty" jsonschema:"Query/subresource parameters. Use an empty string for valueless subresources such as location, uploads, versioning or delete."`
	Headers         map[string]string `json:"headers,omitempty" jsonschema:"Additional request headers, e.g. content-type or x-amz-* headers."`
	Body            string            `json:"body,omitempty" jsonschema:"UTF-8 request body (XML/JSON/text). Ignored when body_base64 or body_path is set."`
	BodyBase64      string            `json:"body_base64,omitempty" jsonschema:"Base64-encoded binary request body."`
	BodyPath        string            `json:"body_path,omitempty" jsonschema:"Local file whose bytes are uploaded as the request body."`
	UnsignedPayload bool              `json:"unsigned_payload,omitempty" jsonschema:"Sign with UNSIGNED-PAYLOAD instead of hashing the body."`
	ResponseFormat  string            `json:"response_format,omitempty" jsonschema:"How to return the response body: auto, text, base64 or none. auto returns text for XML/JSON and base64 otherwise. Defaults to auto."`
	MaxBytes        int               `json:"max_bytes,omitempty" jsonschema:"Maximum inline response bytes before truncation. Defaults to 1000000."`
	SavePath        string            `json:"save_path,omitempty" jsonschema:"Write the full response body to this local file path."`
	TimeoutMS       int               `json:"timeout_ms,omitempty" jsonschema:"HTTP request timeout in milliseconds. Defaults to 30000."`
}

const description = "Call any S3-compatible (MinIO) REST operation with full account privileges: list buckets, list/create/delete buckets, get/put/head/delete objects, multipart upload, versioning, policies, lifecycle and other subresources. There is no operation allowlist. Requests are signed with AWS Signature V4 (path-style). Set method plus optional bucket, key, query subresource params (e.g. {location:''}, {uploads:''}, {'list-type':2, prefix:'a/'}, {partNumber:1, uploadId:'...'}, {delete:''}), headers and a body. The body may be a UTF-8 string (XML/JSON), base64 (body_base64) or a local file (body_path). Responses return status_code, headers, size and the body as text (XML/JSON) or base64; large or binary bodies can be written to save_path instead. Uses minio.endpoint, minio.access_key/minio.secret_key and minio.region, or per-call endpoint/region."

// Module returns the minio tool module.
func Module() tools.ToolModule {
	return tools.ToolModule{
		Name: "minio",
		Register: func(server *mcp.Server) {
			tools.AddTool(server, &mcp.Tool{
				Name:        tools.MinioTool,
				Title:       "MinIO / S3",
				Description: description,
				Annotations: operations.UnrestrictedAnnotations,
			}, handle)
		},
	}
}

func handle(ctx context.Context, _ *mcp.CallToolRequest, in Input) (*mcp.CallToolResult, any, error) {
	cfg := config.Load().Minio
	endpoint := strings.TrimRight(firstNonEmpty(in.Endpoint, cfg.Endpoint), "/")
	if endpoint == "" {
		return operations.ResultErr(tools.MinioTool,
			errors.New("Connection is not configured. Set minio.endpoint or supply endpoint.")), nil, nil
	}
	if cfg.AccessKey == "" || cfg.SecretKey == "" {
		return operations.ResultErr(tools.MinioTool,
			errors.New("Credentials are not configured. Set minio.access_key and minio.secret_key.")), nil, nil
	}
	method := in.Method
	if method == "" {
		method = "GET"
	}
	timeout := in.TimeoutMS
	if timeout <= 0 {
		timeout = defaultTimeout
	}
	maxBytes := in.MaxBytes
	if maxBytes <= 0 {
		maxBytes = defaultMaxByte
	}
	format := in.ResponseFormat
	if format == "" {
		format = "auto"
	}
	region := firstNonEmpty(in.Region, cfg.Region)

	var payload []byte
	switch {
	case in.BodyPath != "":
		data, err := os.ReadFile(in.BodyPath)
		if err != nil {
			return operations.ResultErr(tools.MinioTool, err), nil, nil
		}
		payload = data
	case in.BodyBase64 != "":
		payload = operations.DecodeBase64(in.BodyBase64)
	case in.Body != "":
		payload = []byte(in.Body)
	}

	canonicalURI := BuildCanonicalURI(in.Bucket, in.Key)
	signed := SignRequest(SignOptions{
		Method:          method,
		Endpoint:        endpoint,
		CanonicalURI:    canonicalURI,
		Query:           in.Query,
		Headers:         in.Headers,
		Payload:         payload,
		UnsignedPayload: in.UnsignedPayload,
		Credentials: S3Credentials{
			AccessKey:    cfg.AccessKey,
			SecretKey:    cfg.SecretKey,
			Region:       region,
			SessionToken: cfg.SessionToken,
		},
	})

	var body []byte
	if method != "GET" && method != "HEAD" && len(payload) > 0 {
		body = payload
	}
	res, err := operations.Do(ctx, method, signed.URL, signed.Headers, body, timeout)
	if err != nil {
		return operations.ResultErr(tools.MinioTool, err), nil, nil
	}

	headers := map[string]string{}
	for key, values := range res.Header {
		headers[strings.ToLower(key)] = strings.Join(values, ", ")
	}
	contentType := res.Header.Get("Content-Type")

	result := map[string]any{
		"status_code": res.StatusCode,
		"headers":     headers,
		"size":        len(res.Body),
	}
	if in.SavePath != "" {
		if err := os.WriteFile(in.SavePath, res.Body, 0o644); err != nil {
			return operations.ResultErr(tools.MinioTool, err), nil, nil
		}
		result["saved_to"] = in.SavePath
		result["saved_bytes"] = len(res.Body)
	}

	textual := format == "text" || (format == "auto" && isTextual(contentType, res.Body))
	if format != "none" {
		truncated := len(res.Body) > maxBytes
		slice := res.Body
		if truncated {
			slice = res.Body[:maxBytes]
		}
		switch {
		case textual:
			result["body"] = operations.DecodeUTF8(slice)
			if truncated {
				result["truncated"] = true
			}
		case format == "base64" || (format == "auto" && in.SavePath == ""):
			result["body_base64"] = base64.StdEncoding.EncodeToString(slice)
			if truncated {
				result["truncated"] = true
			}
		}
	}

	out := operations.Result(result)
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		operations.WithError(out)
	}
	return out, nil, nil
}

func isTextual(contentType string, buffer []byte) bool {
	if contentType != "" {
		ct := strings.ToLower(contentType)
		if strings.HasPrefix(ct, "text/") {
			return true
		}
		return textSubtypeRE.MatchString(ct)
	}
	return utf8.Valid(buffer)
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if v != "" {
			return v
		}
	}
	return ""
}

package minio

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"
)

// S3Credentials holds the signing credentials.
type S3Credentials struct {
	AccessKey    string
	SecretKey    string
	Region       string
	SessionToken string
}

// SignedRequest is a produced AWS Signature V4 signed request.
type SignedRequest struct {
	URL           string
	Headers       map[string]string
	ContentSha256 string
}

var emptySHA256 = sha256Hex([]byte(""))

// rfc3986Encode percent-encodes every byte except the RFC 3986 unreserved set
// (A-Za-z0-9-_.~), matching encodeURIComponent plus the [!'()*] replacement
// used by the TypeScript signer.
func rfc3986Encode(value string) string {
	var b strings.Builder
	for i := 0; i < len(value); i++ {
		c := value[i]
		if (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') ||
			c == '-' || c == '_' || c == '.' || c == '~' {
			b.WriteByte(c)
			continue
		}
		fmt.Fprintf(&b, "%%%02X", c)
	}
	return b.String()
}

func hmacSHA256(key, data []byte) []byte {
	h := hmac.New(sha256.New, key)
	h.Write(data)
	return h.Sum(nil)
}

func sha256Hex(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

func signingKey(secretKey, dateStamp, region, service string) []byte {
	kDate := hmacSHA256([]byte("AWS4"+secretKey), []byte(dateStamp))
	kRegion := hmacSHA256(kDate, []byte(region))
	kService := hmacSHA256(kRegion, []byte(service))
	return hmacSHA256(kService, []byte("aws4_request"))
}

// encodeKeyPath encodes an object key, preserving "/" separators.
func encodeKeyPath(key string) string {
	segments := strings.Split(key, "/")
	for i, segment := range segments {
		segments[i] = rfc3986Encode(segment)
	}
	return strings.Join(segments, "/")
}

// BuildCanonicalURI builds the canonical (single-encoded) URI for a path-style
// S3 request.
func BuildCanonicalURI(bucket, key string) string {
	uri := "/"
	if bucket != "" {
		uri += rfc3986Encode(bucket)
		if key != "" {
			uri += "/" + encodeKeyPath(key)
		}
	} else if key != "" {
		uri += encodeKeyPath(key)
	}
	return uri
}

// BuildCanonicalQuery builds the canonical query string: sort by key then
// value, RFC 3986 encode both, and join. Repeated keys (arrays) expand to
// multiple pairs.
func BuildCanonicalQuery(query map[string]any) string {
	type pair struct{ k, v string }
	var pairs []pair
	for _, rawKey := range sortedKeys(query) {
		rawValue := query[rawKey]
		values := []any{rawValue}
		if arr, ok := rawValue.([]any); ok {
			values = arr
		}
		for _, value := range values {
			pairs = append(pairs, pair{rfc3986Encode(rawKey), rfc3986Encode(queryValueToString(value))})
		}
	}
	sort.SliceStable(pairs, func(i, j int) bool {
		if pairs[i].k == pairs[j].k {
			return pairs[i].v < pairs[j].v
		}
		return pairs[i].k < pairs[j].k
	})
	parts := make([]string, len(pairs))
	for i, p := range pairs {
		parts[i] = p.k + "=" + p.v
	}
	return strings.Join(parts, "&")
}

func queryValueToString(value any) string {
	switch v := value.(type) {
	case string:
		return v
	case bool:
		return strconv.FormatBool(v)
	case float64:
		return strconv.FormatFloat(v, 'f', -1, 64)
	case nil:
		return ""
	default:
		return fmt.Sprintf("%v", v)
	}
}

// SignOptions configures SignRequest.
type SignOptions struct {
	Method          string
	Endpoint        string
	CanonicalURI    string
	Query           map[string]any
	Headers         map[string]string
	Payload         []byte
	Credentials     S3Credentials
	UnsignedPayload bool
	Service         string
	Now             time.Time
}

// SignRequest produces an AWS Signature Version 4 signed request for an
// S3-compatible endpoint. Port of signRequest in src/tools/minio/s3.ts.
func SignRequest(opts SignOptions) SignedRequest {
	service := opts.Service
	if service == "" {
		service = "s3"
	}
	now := opts.Now
	if now.IsZero() {
		now = time.Now()
	}
	now = now.UTC()

	base, err := url.Parse(opts.Endpoint)
	if err != nil {
		// The caller validates the endpoint before signing; fall back to the
		// raw string so signing still produces a deterministic result.
		base = &url.URL{Host: strings.TrimPrefix(strings.TrimPrefix(opts.Endpoint, "http://"), "https://")}
	}
	host := base.Host
	origin := base.Scheme + "://" + base.Host
	canonicalQuery := BuildCanonicalQuery(opts.Query)

	contentSha256 := sha256Hex(opts.Payload)
	if opts.UnsignedPayload {
		contentSha256 = "UNSIGNED-PAYLOAD"
	} else if len(opts.Payload) == 0 {
		contentSha256 = emptySHA256
	}

	amzDate := now.Format("20060102T150405Z")
	dateStamp := amzDate[:8]

	signed := map[string]string{}
	for key, value := range opts.Headers {
		signed[strings.ToLower(key)] = strings.Join(strings.Fields(value), " ")
	}
	signed["host"] = host
	signed["x-amz-content-sha256"] = contentSha256
	signed["x-amz-date"] = amzDate
	if opts.Credentials.SessionToken != "" {
		signed["x-amz-security-token"] = opts.Credentials.SessionToken
	}

	names := make([]string, 0, len(signed))
	for name := range signed {
		names = append(names, name)
	}
	sort.Strings(names)

	var canonicalHeaders strings.Builder
	for _, name := range names {
		canonicalHeaders.WriteString(name + ":" + signed[name] + "\n")
	}
	signedHeaders := strings.Join(names, ";")

	canonicalRequest := strings.Join([]string{
		strings.ToUpper(opts.Method),
		opts.CanonicalURI,
		canonicalQuery,
		canonicalHeaders.String(),
		signedHeaders,
		contentSha256,
	}, "\n")

	credentialScope := dateStamp + "/" + opts.Credentials.Region + "/" + service + "/aws4_request"
	stringToSign := strings.Join([]string{
		"AWS4-HMAC-SHA256",
		amzDate,
		credentialScope,
		sha256Hex([]byte(canonicalRequest)),
	}, "\n")

	key := signingKey(opts.Credentials.SecretKey, dateStamp, opts.Credentials.Region, service)
	signature := hex.EncodeToString(hmacSHA256(key, []byte(stringToSign)))

	authorization := fmt.Sprintf(
		"AWS4-HMAC-SHA256 Credential=%s/%s, SignedHeaders=%s, Signature=%s",
		opts.Credentials.AccessKey, credentialScope, signedHeaders, signature)

	outHeaders := map[string]string{}
	for name, value := range signed {
		if name == "host" {
			continue
		}
		outHeaders[name] = value
	}
	outHeaders["authorization"] = authorization

	signedURL := origin + opts.CanonicalURI
	if canonicalQuery != "" {
		signedURL += "?" + canonicalQuery
	}
	return SignedRequest{URL: signedURL, Headers: outHeaders, ContentSha256: contentSha256}
}

// sortedKeys returns the map keys in sorted order.
func sortedKeys(m map[string]any) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

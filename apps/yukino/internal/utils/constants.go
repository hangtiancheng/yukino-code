package utils

import "regexp"

const Redacted = "<redacted>"

var NumericLiteral = regexp.MustCompile(`^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$`)

const MaxRedirects = 5

var RedirectStatuses = map[int]bool{301: true, 302: true, 303: true, 307: true, 308: true}

// NoBodyStatuses are HTTP statuses that never carry a response body, so the
// stream is not wrapped.
var NoBodyStatuses = map[int]bool{101: true, 204: true, 205: true, 304: true}

// SensitiveEnvKeyRe matches key names whose values are treated as secrets and
// redacted from output.
var SensitiveEnvKeyRe = regexp.MustCompile(`(?i)api[_\-]?key|token|secret|password|private[_\-]?key|credential|dsn`)

// BearerTokenRe matches a bearer authorization value; the scheme prefix is
// captured so it survives redaction.
var BearerTokenRe = regexp.MustCompile(`(?i)\b(Bearer\s+)[A-Za-z0-9._~+/=-]+`)

// Subnet is a CIDR block: an address and its prefix length.
type Subnet struct {
	Address string
	Prefix  int
}

// BlockedIPv4Subnets are the IANA special-purpose IPv4 ranges and
// BlockedIPv6Subnets the IPv6 blocks that must never be reached from a
// user-supplied URL.
var BlockedIPv4Subnets = []Subnet{
	{Address: "0.0.0.0", Prefix: 8},
	{Address: "10.0.0.0", Prefix: 8},
	{Address: "100.64.0.0", Prefix: 10},
	{Address: "127.0.0.0", Prefix: 8},
	{Address: "169.254.0.0", Prefix: 16},
	{Address: "172.16.0.0", Prefix: 12},
	{Address: "192.0.0.0", Prefix: 24},
	{Address: "192.0.2.0", Prefix: 24},
	{Address: "192.88.99.0", Prefix: 24},
	{Address: "192.168.0.0", Prefix: 16},
	{Address: "198.18.0.0", Prefix: 15},
	{Address: "198.51.100.0", Prefix: 24},
	{Address: "203.0.113.0", Prefix: 24},
	{Address: "224.0.0.0", Prefix: 4},
	{Address: "240.0.0.0", Prefix: 4},
}

var BlockedIPv6Subnets = []Subnet{
	{Address: "::", Prefix: 3},
	{Address: "4000::", Prefix: 2},
	{Address: "8000::", Prefix: 1},
	{Address: "2001::", Prefix: 32},
	{Address: "2001:2::", Prefix: 48},
	{Address: "2001:10::", Prefix: 28},
	{Address: "2001:db8::", Prefix: 32},
	{Address: "2002::", Prefix: 16},
	{Address: "3fff::", Prefix: 20},
}

// Skill URL validation failures.
const (
	SkillURLProtocolError        = "Skill URL must use HTTP or HTTPS"
	SkillURLCredentialsError     = "Skill URL must not contain credentials"
	SkillURLNonPublicError       = "Skill URL resolves to a non-public network address"
	SkillURLUnreachableError     = "Skill URL has no reachable public address"
	SkillURLMissingLocationError = "Skill download redirect is missing a Location header"

	PublicHTTPBodyUnsupportedError = "fetchPublicHttpUrl does not support a request body"
)

const (
	MaxSymlinkDepth      = 40
	TooManySymlinksError = "Too many symbolic links while resolving path"
)

const (
	DefaultScanMaxFiles         = 2000
	MinScanVisitedBudget        = 2000
	ScanVisitedBudgetMultiplier = 10
	DefaultFileMatchLimit       = 8
)

const ToolArgsSummaryChars = 80

package remote

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"fmt"
	"net"
	"net/http"
	"net/netip"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf8"

	"golang.org/x/net/idna"
)

var remoteAddressPattern = regexp.MustCompile(`^(?:\[([^\]]+)\]|([^:]*))(?::([0-9]+))?$`)
var remotePortPattern = regexp.MustCompile(`^[0-9]+$`)

func ParseRemoteAddress(address string, defaultPort int, allowEphemeral bool) (string, int, error) {
	value := strings.TrimSpace(address)
	host, portText := "", ""
	if remotePortPattern.MatchString(value) {
		portText = value
	} else {
		match := remoteAddressPattern.FindStringSubmatch(value)
		if match == nil {
			return "", 0, fmt.Errorf("Invalid remote address; use port, host:port or [IPv6]:port")
		}
		host = match[1]
		if host == "" {
			host = match[2]
		}
		portText = match[3]
	}
	port := defaultPort
	if portText != "" {
		parsed, err := strconv.Atoi(portText)
		if err != nil {
			port = -1
		} else {
			port = parsed
		}
	}
	minimum := 1
	if allowEphemeral {
		minimum = 0
	}
	if port < minimum || port > 65535 {
		return "", 0, fmt.Errorf("Remote port must be an integer between %d and 65535", minimum)
	}
	if host == "" {
		host = "127.0.0.1"
	}
	return host, port, nil
}
func createAccessToken() string {
	bytes := make([]byte, 32)
	if _, err := rand.Read(bytes); err != nil {
		panic(err)
	}
	return base64.RawURLEncoding.EncodeToString(bytes)
}
func authorizeWebSocket(r *http.Request, path, token string) (int, string) {
	if r.URL.Path != path {
		return http.StatusNotFound, "Not Found"
	}
	provided := r.URL.Query().Get("token")
	if provided == "" || len(provided) != len(token) || subtle.ConstantTimeCompare([]byte(provided), []byte(token)) != 1 {
		return http.StatusUnauthorized, "Unauthorized"
	}
	if origin, present := r.Header["Origin"]; present {
		if len(origin) != 1 || r.Host == "" {
			return http.StatusForbidden, "Forbidden"
		}
		host, ok := parseOriginHost(origin[0])
		if !ok || host != r.Host {
			return http.StatusForbidden, "Forbidden"
		}
	}
	return 0, ""
}

// originIDNA mirrors the reference URL parser's "domain to ASCII" step with
// beStrict=false (UTS #46: CheckHyphens=false, CheckBidi=true, CheckJoiners=true,
// UseSTD3ASCIIRules=false, Transitional=false, VerifyDnsLength=false).
var originIDNA = idna.New(
	idna.MapForLookup(),
	idna.BidiRule(),
	idna.StrictDomainName(false),
	idna.CheckHyphens(false),
)

// parseOriginHost returns the WHATWG serialization of `new URL(origin).host`
// for http origins, or false when the reference URL parser would throw or the
// scheme is not "http:".
func parseOriginHost(origin string) (string, bool) {
	// The URL parser trims leading/trailing C0-control-or-space and removes
	// all ASCII tab/newline before parsing.
	input := strings.TrimFunc(origin, func(r rune) bool { return r <= 0x20 })
	input = strings.Map(func(r rune) rune {
		if r == '\t' || r == '\n' || r == '\r' {
			return -1
		}
		return r
	}, input)
	if len(input) < 5 || input[4] != ':' || !strings.EqualFold(input[:4], "http") {
		return "", false
	}
	// Special schemes skip any run of "/" and "\" before the authority.
	authority := strings.TrimLeft(input[5:], "/\\")
	if i := strings.IndexAny(authority, "/\\?#"); i >= 0 {
		authority = authority[:i]
	}
	if i := strings.LastIndex(authority, "@"); i >= 0 {
		authority = authority[i+1:]
	}
	hostText, portText, ok := splitOriginAuthority(authority)
	if !ok {
		return "", false
	}
	host, ok := parseOriginHostText(hostText)
	if !ok || host == "" {
		return "", false
	}
	if portText == "" {
		return host, true
	}
	port, ok := parseOriginPort(portText)
	if !ok {
		return "", false
	}
	if port == 80 {
		return host, true
	}
	return host + ":" + strconv.Itoa(port), true
}

func splitOriginAuthority(authority string) (host, port string, ok bool) {
	if strings.HasPrefix(authority, "[") {
		end := strings.Index(authority, "]")
		if end < 0 {
			return "", "", false
		}
		rest := authority[end+1:]
		if rest == "" {
			return authority[:end+1], "", true
		}
		if rest[0] != ':' {
			return "", "", false
		}
		return authority[:end+1], rest[1:], true
	}
	if i := strings.Index(authority, ":"); i >= 0 {
		return authority[:i], authority[i+1:], true
	}
	return authority, "", true
}

func parseOriginHostText(text string) (string, bool) {
	if text == "" {
		return "", false
	}
	if text[0] == '[' {
		if !strings.HasSuffix(text, "]") {
			return "", false
		}
		inner := text[1 : len(text)-1]
		if strings.Contains(inner, "%") {
			return "", false
		}
		addr, err := netip.ParseAddr(inner)
		if err != nil || addr.Is4() {
			return "", false
		}
		return "[" + serializeIPv6(addr.As16()) + "]", true
	}
	if endsInNumber(text) {
		return parseIPv4Host(text)
	}
	return domainToASCII(text)
}

// serializeIPv6 follows the WHATWG IPv6 serializer: lowercase hex groups, the
// longest zero run of at least two compressed (first run wins ties), and no
// embedded IPv4 form.
func serializeIPv6(addr [16]byte) string {
	var pieces [8]uint16
	for i := range pieces {
		pieces[i] = uint16(addr[2*i])<<8 | uint16(addr[2*i+1])
	}
	compressStart, compressLen := -1, 0
	for i := 0; i < 8; {
		if pieces[i] != 0 {
			i++
			continue
		}
		start := i
		for i < 8 && pieces[i] == 0 {
			i++
		}
		if i-start > compressLen {
			compressStart, compressLen = start, i-start
		}
	}
	if compressLen < 2 {
		compressStart = -1
	}
	var b strings.Builder
	for i := 0; i < 8; {
		if i == compressStart {
			if i == 0 {
				b.WriteString("::")
			} else {
				b.WriteByte(':')
			}
			i += compressLen
			continue
		}
		b.WriteString(strconv.FormatUint(uint64(pieces[i]), 16))
		if i != 7 {
			b.WriteByte(':')
		}
		i++
	}
	return b.String()
}

// endsInNumber follows the WHATWG predicate that routes a host through the
// IPv4 parser.
func endsInNumber(input string) bool {
	parts := strings.Split(input, ".")
	last := parts[len(parts)-1]
	if last == "" {
		if len(parts) == 1 {
			return false
		}
		last = parts[len(parts)-2]
	}
	if last == "" {
		return false
	}
	if len(last) >= 2 && (last[:2] == "0x" || last[:2] == "0X") {
		last = last[2:]
		if last == "" {
			return true
		}
		return allDigits(last, 16)
	}
	return allDigits(last, 10)
}

func allDigits(input string, radix int) bool {
	for i := 0; i < len(input); i++ {
		if _, err := strconv.ParseUint(input[i:i+1], radix, 8); err != nil {
			return false
		}
	}
	return true
}

func parseIPv4Number(part string) (uint64, bool) {
	if part == "" {
		return 0, false
	}
	radix := 10
	if len(part) >= 2 && (part[:2] == "0x" || part[:2] == "0X") {
		part = part[2:]
		radix = 16
	} else if len(part) > 1 && part[0] == '0' {
		part = part[1:]
		radix = 8
	}
	if part == "" {
		return 0, true
	}
	value, err := strconv.ParseUint(part, radix, 64)
	if err != nil {
		return 0, false
	}
	return value, true
}

func parseIPv4Host(input string) (string, bool) {
	parts := strings.Split(input, ".")
	if parts[len(parts)-1] == "" {
		if len(parts) == 1 {
			return "", false
		}
		parts = parts[:len(parts)-1]
	}
	if len(parts) > 4 {
		return "", false
	}
	numbers := make([]uint64, 0, len(parts))
	for _, part := range parts {
		if part == "" {
			return "", false
		}
		number, ok := parseIPv4Number(part)
		if !ok {
			return "", false
		}
		numbers = append(numbers, number)
	}
	last := numbers[len(numbers)-1]
	numbers = numbers[:len(numbers)-1]
	if last > uint64(1)<<(8*(5-len(parts)))-1 {
		return "", false
	}
	ipv4 := last
	for i, number := range numbers {
		if number > 255 {
			return "", false
		}
		ipv4 += number << (8 * (3 - i))
	}
	return fmt.Sprintf("%d.%d.%d.%d", ipv4>>24&0xff, ipv4>>16&0xff, ipv4>>8&0xff, ipv4&0xff), true
}

// domainToASCII mirrors the WHATWG domain parser: percent-decode, UTS #46
// ToASCII with beStrict=false, then reject forbidden domain code points.
func domainToASCII(input string) (string, bool) {
	decoded := percentDecodeHost(input)
	if !utf8.ValidString(decoded) {
		return "", false
	}
	ascii, err := originIDNA.ToASCII(decoded)
	if err != nil || ascii == "" {
		return "", false
	}
	if hasForbiddenDomainCodePoint(ascii) {
		return "", false
	}
	return ascii, true
}

func percentDecodeHost(input string) string {
	if !strings.Contains(input, "%") {
		return input
	}
	var b strings.Builder
	for i := 0; i < len(input); {
		if input[i] == '%' && i+2 < len(input) && hexValue(input[i+1]) >= 0 && hexValue(input[i+2]) >= 0 {
			b.WriteByte(byte(hexValue(input[i+1])<<4 | hexValue(input[i+2])))
			i += 3
			continue
		}
		b.WriteByte(input[i])
		i++
	}
	return b.String()
}

func hexValue(c byte) int {
	switch {
	case c >= '0' && c <= '9':
		return int(c - '0')
	case c >= 'a' && c <= 'f':
		return int(c-'a') + 10
	case c >= 'A' && c <= 'F':
		return int(c-'A') + 10
	}
	return -1
}

func hasForbiddenDomainCodePoint(input string) bool {
	for i := 0; i < len(input); i++ {
		c := input[i]
		if c <= 0x20 || c == 0x7f || strings.IndexByte("#/:<>?@[]^|%", c) >= 0 {
			return true
		}
	}
	return false
}

func parseOriginPort(text string) (int, bool) {
	for i := 0; i < len(text); i++ {
		if text[i] < '0' || text[i] > '9' {
			return 0, false
		}
	}
	value, err := strconv.Atoi(text)
	if err != nil || value > 65535 {
		return 0, false
	}
	return value, true
}
func (s *Server) listenAddress() (string, error) {
	host, port, err := ParseRemoteAddress(s.addr, 18888, true)
	if err != nil {
		return "", err
	}
	return net.JoinHostPort(host, strconv.Itoa(port)), nil
}

package utils

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
)

// LookupAddress is one resolved address with its IP family.
type LookupAddress struct {
	Address string
	Family  int
}

// HostLookup resolves all addresses of a hostname.
type HostLookup func(ctx context.Context, hostname string) ([]LookupAddress, error)

// PublicHttpDependencies overrides the fetcher or resolver (tests).
type PublicHttpDependencies struct {
	// Fetcher, when set, replaces the pinned transport. It must not follow
	// redirects (the redirect loop is manual, mirroring redirect: "manual").
	Fetcher func(req *http.Request) (*http.Response, error)
	Lookup  HostLookup
}

var (
	blockedIPv4Nets = buildCIDRs(BlockedIPv4Subnets)
	blockedIPv6Nets = buildCIDRs(BlockedIPv6Subnets)
)

func buildCIDRs(subnets []Subnet) []*net.IPNet {
	var nets []*net.IPNet
	for _, subnet := range subnets {
		_, ipnet, err := net.ParseCIDR(fmt.Sprintf("%s/%d", subnet.Address, subnet.Prefix))
		if err == nil {
			nets = append(nets, ipnet)
		}
	}
	return nets
}

func inCIDRs(ip net.IP, nets []*net.IPNet) bool {
	for _, ipnet := range nets {
		if ipnet.Contains(ip) {
			return true
		}
	}
	return false
}

// ipFamily mirrors node:net isIP: 4, 6, or 0.
func ipFamily(address string) int {
	ip := net.ParseIP(address)
	if ip == nil {
		return 0
	}
	if strings.Contains(address, ":") {
		return 6
	}
	if ip.To4() != nil {
		return 4
	}
	return 0
}

// IsPublicIPAddress reports whether the address is outside the blocked
// special-purpose ranges. The list is chosen from the parsed IP (Go
// normalizes IPv4-mapped IPv6 literals to IPv4, matching Node's BlockList
// auto-detection).
func IsPublicIPAddress(address string) bool {
	ip := net.ParseIP(address)
	if ip == nil {
		return false
	}
	if ip.To4() != nil {
		return !inCIDRs(ip, blockedIPv4Nets)
	}
	return !inCIDRs(ip, blockedIPv6Nets)
}

func defaultLookup(ctx context.Context, hostname string) ([]LookupAddress, error) {
	ips, err := net.DefaultResolver.LookupIPAddr(ctx, hostname)
	if err != nil {
		return nil, err
	}
	out := make([]LookupAddress, 0, len(ips))
	for _, ipAddr := range ips {
		out = append(out, LookupAddress{Address: ipAddr.String(), Family: ipFamily(ipAddr.String())})
	}
	return out, nil
}

func resolvePublicHttpURL(ctx context.Context, input string, lookup HostLookup) (*url.URL, []LookupAddress, error) {
	parsed, err := url.Parse(input)
	if err != nil {
		return nil, nil, err
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return nil, nil, errors.New(SkillURLProtocolError)
	}
	if parsed.User != nil {
		_, hasPassword := parsed.User.Password()
		if parsed.User.Username() != "" || hasPassword {
			return nil, nil, errors.New(SkillURLCredentialsError)
		}
	}
	hostname := parsed.Hostname()
	var resolved []LookupAddress
	if family := ipFamily(hostname); family != 0 {
		resolved = []LookupAddress{{Address: hostname, Family: family}}
	} else {
		resolved, err = lookup(ctx, hostname)
		if err != nil {
			return nil, nil, err
		}
	}
	addresses := make([]LookupAddress, 0, len(resolved))
	for _, entry := range resolved {
		addresses = append(addresses, LookupAddress{Address: entry.Address, Family: ipFamily(entry.Address)})
	}
	if len(addresses) == 0 {
		return nil, nil, errors.New(SkillURLNonPublicError)
	}
	for _, entry := range addresses {
		if (entry.Family != 4 && entry.Family != 6) || !IsPublicIPAddress(entry.Address) {
			return nil, nil, errors.New(SkillURLNonPublicError)
		}
	}
	return parsed, addresses, nil
}

func portOrDefault(u *url.URL) string {
	if port := u.Port(); port != "" {
		return port
	}
	if u.Scheme == "https" {
		return "443"
	}
	return "80"
}

// fetchPinnedAddress issues the request with the connection pinned to the
// resolved address (DNS-rebinding defense); TLS ServerName stays the URL host.
func fetchPinnedAddress(ctx context.Context, u *url.URL, method string, headers http.Header, address LookupAddress) (*http.Response, error) {
	dialAddr := net.JoinHostPort(address.Address, portOrDefault(u))
	transport := &http.Transport{
		DialContext: func(ctx context.Context, network, _ string) (net.Conn, error) {
			var dialer net.Dialer
			return dialer.DialContext(ctx, network, dialAddr)
		},
	}
	defer transport.CloseIdleConnections()
	client := &http.Client{
		Transport: transport,
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
	req, err := http.NewRequestWithContext(ctx, method, u.String(), nil)
	if err != nil {
		return nil, err
	}
	for name, values := range headers {
		for _, value := range values {
			req.Header.Add(name, value)
		}
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	if NoBodyStatuses[resp.StatusCode] {
		_, _ = io.Copy(io.Discard, resp.Body)
		_ = resp.Body.Close()
		resp.Body = http.NoBody
	}
	return resp, nil
}

func fetchPinnedAddresses(ctx context.Context, u *url.URL, method string, headers http.Header, addresses []LookupAddress) (*http.Response, error) {
	var lastError error
	for _, address := range addresses {
		resp, err := fetchPinnedAddress(ctx, u, method, headers, address)
		if err == nil {
			return resp, nil
		}
		if ctxErr := ctx.Err(); ctxErr != nil {
			return nil, ctxErr
		}
		lastError = err
	}
	if lastError != nil {
		return nil, fmt.Errorf("%s: %w", SkillURLUnreachableError, lastError)
	}
	return nil, errors.New(SkillURLUnreachableError)
}

// assertBodylessGetOrHead narrows the contract to bodyless GET/HEAD up front,
// mirroring the reference (the pinned path streams no request body).
func assertBodylessGetOrHead(method string) error {
	upper := strings.ToUpper(method)
	if upper == "" {
		upper = "GET"
	}
	if upper != "GET" && upper != "HEAD" {
		return fmt.Errorf("fetchPublicHttpUrl only supports GET or HEAD, received '%s'", upper)
	}
	return nil
}

// FetchPublicHttpUrl fetches input with SSRF protection: only public
// addresses resolve, connections pin the resolved address, and redirects are
// followed manually (re-validating every hop) up to MaxRedirects.
func FetchPublicHttpUrl(ctx context.Context, input, method string, headers http.Header, deps PublicHttpDependencies) (*http.Response, error) {
	if err := assertBodylessGetOrHead(method); err != nil {
		return nil, err
	}
	if strings.ToUpper(method) == "" {
		method = "GET"
	}
	lookup := deps.Lookup
	if lookup == nil {
		lookup = defaultLookup
	}
	current := input
	for redirects := 0; ; redirects++ {
		resolvedURL, addresses, err := resolvePublicHttpURL(ctx, current, lookup)
		if err != nil {
			return nil, err
		}
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		var resp *http.Response
		if deps.Fetcher != nil {
			req, reqErr := http.NewRequestWithContext(ctx, strings.ToUpper(method), resolvedURL.String(), nil)
			if reqErr != nil {
				return nil, reqErr
			}
			for name, values := range headers {
				for _, value := range values {
					req.Header.Add(name, value)
				}
			}
			resp, err = deps.Fetcher(req)
		} else {
			resp, err = fetchPinnedAddresses(ctx, resolvedURL, strings.ToUpper(method), headers, addresses)
		}
		if err != nil {
			return nil, err
		}
		if !RedirectStatuses[resp.StatusCode] {
			return resp, nil
		}
		if resp.Body != nil {
			_, _ = io.Copy(io.Discard, resp.Body)
			_ = resp.Body.Close()
		}
		if redirects >= MaxRedirects {
			return nil, fmt.Errorf("Skill download exceeded %d redirects", MaxRedirects)
		}
		location := resp.Header.Get("Location")
		if location == "" {
			return nil, errors.New(SkillURLMissingLocationError)
		}
		next, err := resolvedURL.Parse(location)
		if err != nil {
			return nil, err
		}
		current = next.String()
	}
}

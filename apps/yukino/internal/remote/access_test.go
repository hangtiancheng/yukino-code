package remote

import (
	"net/http/httptest"
	"testing"
)

func TestRemoteAddressForms(t *testing.T) {
	for _, tc := range []struct {
		in, host string
		port     int
	}{{"", "127.0.0.1", 18888}, {"9000", "127.0.0.1", 9000}, {"localhost", "localhost", 18888}, {":9000", "127.0.0.1", 9000}, {"[::1]:9000", "::1", 9000}} {
		host, port, err := ParseRemoteAddress(tc.in, 18888, false)
		if err != nil || host != tc.host || port != tc.port {
			t.Fatal(tc, host, port, err)
		}
	}
	for _, input := range []string{"0", "65536", "host:", "::1", "host:-1"} {
		if _, _, err := ParseRemoteAddress(input, 18888, false); err == nil {
			t.Fatal(input)
		}
	}
	if _, port, err := ParseRemoteAddress("0", 18888, true); err != nil || port != 0 {
		t.Fatal(port, err)
	}
}
func TestWebSocketTokenAndOrigin(t *testing.T) {
	token := createAccessToken()
	if len(token) != 43 || token == createAccessToken() {
		t.Fatal("invalid access token")
	}
	for _, tc := range []struct {
		path, origin string
		want         int
	}{{"/ws?token=" + token, "", 0}, {"/ws?token=" + token, "http://localhost:18888", 0}, {"/ws?token=" + token, "HTTP://LOCALHOST:18888", 0}, {"/ws?token=" + token, "http://LOCALHOST:80", 0}, {"/ws?token=" + token, "http://[::1]:80", 0}, {"/other?token=" + token, "", 404}, {"/ws", "", 401}, {"/ws?token=wrong", "", 401}, {"/ws?token=" + token, "https://localhost:18888", 403}, {"/ws?token=" + token, "http://other", 403}, {"/ws?token=" + token, "null", 403}, {"/ws?token=" + token, "http://2130706433", 403}, {"/ws?token=" + token, " http://localhost:18888 ", 0}} {
		r := httptest.NewRequest("GET", "http://localhost:18888"+tc.path, nil)
		if tc.origin != "" {
			r.Header.Set("Origin", tc.origin)
		}
		if tc.origin == "http://LOCALHOST:80" {
			r.Host = "localhost"
		}
		if tc.origin == "http://[::1]:80" {
			r.Host = "[::1]"
		}
		status, _ := authorizeWebSocket(r, "/ws", token)
		if status != tc.want {
			t.Fatal(tc, status)
		}
	}
}

// TestParseOriginHostWhatwg pins parseOriginHost to `new URL(origin).host`
// results captured from the reference TypeScript URL parser.
func TestParseOriginHostWhatwg(t *testing.T) {
	for _, tc := range []struct {
		origin string
		host   string
		ok     bool
	}{
		{"http://localhost:18888", "localhost:18888", true},
		{"HTTP://LOCALHOST:18888", "localhost:18888", true},
		{"http://LOCALHOST:80", "localhost", true},
		{"http://localhost:0", "localhost:0", true},
		{"http://localhost:080", "localhost", true},
		{"http://LOCALHOST:018888", "localhost:18888", true},
		{"http://localhost:65536", "", false},
		{"http://localhost:99999", "", false},
		{"http://localhost:abc", "", false},
		{"http://localhost:", "localhost", true},
		{" http://localhost:18888 ", "localhost:18888", true},
		{"http://local\thost:18888", "localhost:18888", true},
		{"http://local\nhost", "localhost", true},
		{"http://[::1]:80", "[::1]", true},
		{"http://[::1]", "[::1]", true},
		{"http://[::1]:00080", "[::1]", true},
		{"http://[::1]:08080", "[::1]:8080", true},
		{"http://[::ffff:1.2.3.4]", "[::ffff:102:304]", true},
		{"http://[::ffff:0:0]", "[::ffff:0:0]", true},
		{"http://[0:0::0:0]", "[::]", true},
		{"http://[0:0:0:0:0:0:0:1]", "[::1]", true},
		{"http://[1:2:3:4:5:6:7:8]", "[1:2:3:4:5:6:7:8]", true},
		{"http://[1:2:3:4:5:6:0:0]", "[1:2:3:4:5:6::]", true},
		{"http://[ABCD::1]", "[abcd::1]", true},
		{"http://[0001::1]", "[1::1]", true},
		{"http://[0:0:0:0:0:0:1.2.3.4]", "[::102:304]", true},
		{"http://[1:2:3:4:5:6:1.2.3.4]", "[1:2:3:4:5:6:102:304]", true},
		{"http://[::1.2.3.04]", "", false},
		{"http://[::0x1.2.3.4]", "", false},
		{"http://[::256.1.1.1]", "", false},
		{"http://[1.2.3.4]", "", false},
		{"http://[1:2:3:4:5:6:7:1.2.3.4]", "", false},
		{"http://[1::2::3]", "", false},
		{"http://[1:2:3:4:5:6:7:8:9]", "", false},
		{"http://[1:2:3:4:5:6:7:8:]", "", false},
		{"http://[]", "", false},
		{"http://[::%31]", "", false},
		{"http://[fe80::1%25eth0]", "", false},
		{"http://[fe80::1%eth0]", "", false},
		{"http://2130706433", "127.0.0.1", true},
		{"http://0x7f.0.0.1", "127.0.0.1", true},
		{"http://0177.0.0.01", "127.0.0.1", true},
		{"http://184.25.0x1f.9", "184.25.31.9", true},
		{"http://1.2.3.04", "1.2.3.4", true},
		{"http://1.2.3.010", "1.2.3.8", true},
		{"http://1.2.3.08", "", false},
		{"http://1.2.3.4.", "1.2.3.4", true},
		{"http://1.2.3", "1.2.0.3", true},
		{"http://1.2", "1.0.0.2", true},
		{"http://1", "0.0.0.1", true},
		{"http://1.", "0.0.0.1", true},
		{"http://0x", "0.0.0.0", true},
		{"http://0", "0.0.0.0", true},
		{"http://00", "0.0.0.0", true},
		{"http://09", "", false},
		{"http://18888", "0.0.73.200", true},
		{"http://256.1.1.1", "", false},
		{"http://0x100.0.0.1", "", false},
		{"http://999.1.1.1", "", false},
		{"http://1.2.3.4.5", "", false},
		{"http://1..2", "", false},
		{"http://.1", "", false},
		{"http://.1.", "", false},
		{"http://1.0x2e", "1.0.0.46", true},
		{"http://1.0X2E", "1.0.0.46", true},
		{"http://0X10", "0.0.0.16", true},
		{"http://0xff", "0.0.0.255", true},
		{"http://a.0x", "", false},
		{"http://1..", "1..", true},
		{"http://1.2.3.4..", "1.2.3.4..", true},
		{"http://1.2.3.4x", "1.2.3.4x", true},
		{"http://1e5", "1e5", true},
		{"http://0xg", "0xg", true},
		{"http://+1", "+1", true},
		{"http://1.2.3.+4", "1.2.3.+4", true},
		{"http://1.2.3.4e0", "1.2.3.4e0", true},
		{"http://exa%6Dple.com", "example.com", true},
		{"http://foo%2e.com", "foo..com", true},
		{"http://%6c%6f%63%61%6c%68%6f%73%74:18888", "localhost:18888", true},
		{"http://exa%25mple.com", "", false},
		{"http://exa%zzple.com", "", false},
		{"http://localhost%3a18888", "", false},
		{"http://local%2fhost", "", false},
		{"http://example.com%00", "", false},
		{"http://foo%E9.com", "", false},
		{"http://user:pass@localhost:18888", "localhost:18888", true},
		{"http://@localhost", "localhost", true},
		{"http://localhost:18888/path?q#f", "localhost:18888", true},
		{"http:", "", false},
		{"http://", "", false},
		{"http://:80", "", false},
		{"http:/localhost", "localhost", true},
		{"http:localhost:18888", "localhost:18888", true},
		{"http:\\localhost:18888", "localhost:18888", true},
		{"http:///localhost:18888", "localhost:18888", true},
		{"http://localhost^x", "", false},
		{"http://local host", "", false},
		{"http://local|host", "", false},
		{"http://\x01localhost", "", false},
		{"http://ü.example.com", "xn--tda.example.com", true},
		{"http://xn--tda.example.com", "xn--tda.example.com", true},
		{"http://münchen.de", "xn--mnchen-3ya.de", true},
		{"http://straße.de", "xn--strae-oqa.de", true},
		{"http://STRASSE.de", "strasse.de", true},
		{"http://İ.example.com", "xn--i-9bb.example.com", true},
		{"http://fullｗidth.example", "fullwidth.example", true},
		{"http://％６１.com", "", false},
		{"http://βόλος.com", "xn--nxasmm1c.com", true},
		{"http://xn--nxasmq6b", "xn--nxasmq6b", true},
		{"http://xn--", "", false},
		{"http://xn--a-ecp.ru", "", false},
		{"http://-.com", "-.com", true},
		{"http://a..b", "a..b", true},
		{"http://_host", "_host", true},
		{"http://exam_ple.com", "exam_ple.com", true},
		{"http://EXAMPLE.COM.", "example.com.", true},
		{"https://localhost", "", false},
		{"ftp://localhost", "", false},
		{"null", "", false},
		{"", "", false},
		{"localhost:18888", "", false},
	} {
		host, ok := parseOriginHost(tc.origin)
		if host != tc.host || ok != tc.ok {
			t.Fatalf("%q => %q,%v; want %q,%v", tc.origin, host, ok, tc.host, tc.ok)
		}
	}
}

package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestJSONCDefaultsAndStructuredConnections(t *testing.T) {
	t.Setenv("MYSQL_URL", "ignored")
	t.Setenv("PORT", "9999")
	cfg, err := Parse([]byte(`{
 // Passwords and URLs must retain literal comment markers.
 "mysql":{"username":"user","password":"p@ss:// /* x */","host":"::1","database":"db",},
 "embedding":{"model":"test","base_url":"https://example.com/v1","api_key":"key"},
 "etcd":{"url":" one:2379, two:2379 "},
 "milvus":{"username":"user","password":"pass"},
 }`))
	if err != nil {
		t.Fatal(err)
	}
	if cfg.MySQL.Host != "::1" || cfg.MySQL.Port != 3306 || cfg.MySQL.Password != "p@ss:// /* x */" || cfg.Port != 3300 || cfg.Etcd.URL != "http://one:2379" || cfg.Milvus.Token != "user:pass" || !cfg.Embedding.OK {
		t.Fatalf("configuration: %+v", cfg)
	}
}
func TestInvalidConfigurationIsRejected(t *testing.T) {
	for _, raw := range []string{
		`{"mysql":{"dsn":"user:pass@tcp(localhost)/db"}}`,
		`{"mysql":{"url":"mysql://user:pass@localhost/db"}}`,
		`{"mysql":{"username":"user"}}`,
		`{"mysql":{"username":"user","password":null}}`,
		`{"mysql":{"password":"pass"}}`,
		`{"mysql":{"username":"user","password":"","port":0}}`,
		`{"port":65536}`, `{"transport":"invalid"}`, `{"unknown":true}`,
		`null`, `[]`, `{} {}`, `{"host":`,
	} {
		t.Run(raw, func(t *testing.T) {
			if _, err := Parse([]byte(raw)); err == nil {
				t.Fatal("accepted invalid configuration")
			}
		})
	}
	if _, err := Parse([]byte(`{"mysql":{"username":"user","password":""}}`)); err != nil {
		t.Fatal(err)
	}
}
func TestLoadFileAndFailurePreservesSnapshot(t *testing.T) {
	previous := Load()
	t.Cleanup(func() { Set(previous) })
	path := filepath.Join(t.TempDir(), "config.json")
	if err := os.WriteFile(path, []byte(`{"port":1234}`), 0600); err != nil {
		t.Fatal(err)
	}
	if err := LoadFile(path); err != nil {
		t.Fatal(err)
	}
	if Load().Port != 1234 {
		t.Fatal("configuration not installed")
	}
	if err := LoadFile(path + ".missing"); err == nil {
		t.Fatal("missing file accepted")
	}
	if Load().Port != 1234 {
		t.Fatal("failed load replaced configuration")
	}
}
func TestExampleConfiguration(t *testing.T) {
	raw, err := os.ReadFile("../../.example.jsonc")
	if err != nil {
		t.Fatal(err)
	}
	cfg, err := Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.MySQL.Username == "" || !strings.Contains(cfg.Embedding.Reason, "embedding.model") {
		t.Fatalf("example: %+v", cfg)
	}
}
func TestTLSValidation(t *testing.T) {
	if _, err := TLS(&TLSConfig{CertFile: "missing"}, "localhost"); err == nil {
		t.Fatal("unpaired client certificate accepted")
	}
	if _, err := TLS(&TLSConfig{CAFile: "missing"}, "localhost"); err == nil {
		t.Fatal("missing CA accepted")
	}
	cfg, err := TLS(&TLSConfig{}, "localhost")
	if err != nil || cfg.InsecureSkipVerify || cfg.ServerName != "localhost" {
		t.Fatalf("TLS defaults: %+v %v", cfg, err)
	}
}

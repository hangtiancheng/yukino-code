package mysql

import (
	"strings"
	"testing"
	"time"

	mysqldriver "github.com/go-sql-driver/mysql"
)

func TestNormalizeValuePreservesText(t *testing.T) {
	for _, text := range []string{"00123", "1e3", "12.50", "9223372036854775808"} {
		if got := normalizeValue([]byte(text)); got != text {
			t.Errorf("normalizeValue(%q) = %#v", text, got)
		}
	}
	if got := normalizeValue(int64(42)); got != int64(42) {
		t.Fatalf("integer changed: %#v", got)
	}
}

func TestToDSNPreservesConnectionOptions(t *testing.T) {
	dsn, err := toDSN("mysql://user:p%40ss@localhost/db?tls=true&timeout=3s&charset=utf8mb4")
	if err != nil {
		t.Fatal(err)
	}
	cfg, err := mysqldriver.ParseDSN(dsn)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.TLSConfig != "true" || cfg.Timeout != 3*time.Second || !strings.Contains(dsn, "charset=utf8mb4") {
		t.Fatalf("connection options lost: %+v", cfg)
	}
	if cfg.Addr != "localhost:3306" || cfg.Passwd != "p@ss" || !cfg.MultiStatements || !cfg.InterpolateParams {
		t.Fatalf("invalid config: %+v", cfg)
	}
}

func TestToDSNEnablesBatchesForNativeDSN(t *testing.T) {
	dsn, err := toDSN("user:pass@tcp(localhost:3306)/db?tls=true")
	if err != nil {
		t.Fatal(err)
	}
	cfg, err := mysqldriver.ParseDSN(dsn)
	if err != nil {
		t.Fatal(err)
	}
	if !cfg.MultiStatements || !cfg.InterpolateParams || cfg.TLSConfig != "true" {
		t.Fatalf("invalid config: %+v", cfg)
	}
}

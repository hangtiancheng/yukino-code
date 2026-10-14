package mysql

import (
	"strings"
	"testing"
	"time"

	wire "github.com/go-mysql-org/go-mysql/mysql"
	mysqldriver "github.com/go-sql-driver/mysql"
)

func TestTextFieldsPreserveNumericLookingValues(t *testing.T) {
	for _, text := range []string{"00123", "1e3", "12.50", "9223372036854775808"} {
		if got, err := normalizeField([]byte(text), &wire.Field{Type: wire.MYSQL_TYPE_VAR_STRING, Charset: 45}, time.UTC); err != nil || got != text {
			t.Errorf("normalizeField(%q) = %#v, %v", text, got, err)
		}
	}
}

func TestJSONPreservesUnsafeIntegerLexemes(t *testing.T) {
	got, err := normalizeField([]byte(`{"big":9007199254740993,"negative":-9007199254740993,"small":1,"exponent":1e20}`), &wire.Field{Type: wire.MYSQL_TYPE_JSON}, time.UTC)
	if err != nil {
		t.Fatal(err)
	}
	value := got.(map[string]any)
	if value["big"] != "9007199254740993" || value["negative"] != "-9007199254740993" || value["small"] != float64(1) || value["exponent"] != float64(1e20) {
		t.Fatalf("JSON number types: %#v", value)
	}
}

func TestDateAndDatetimeZeroValuesMatchMySQL2(t *testing.T) {
	date, err := normalizeField([]byte("0000-00-00"), &wire.Field{Type: wire.MYSQL_TYPE_DATE}, time.UTC)
	if err != nil || date != "1899-11-30T00:00:00.000Z" {
		t.Fatalf("zero DATE: %#v %v", date, err)
	}
	datetime, err := normalizeField([]byte("0000-00-00 00:00:00"), &wire.Field{Type: wire.MYSQL_TYPE_DATETIME}, time.UTC)
	if err != nil || datetime != nil {
		t.Fatalf("zero DATETIME: %#v %v", datetime, err)
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

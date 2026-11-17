package mysql

import (
	"testing"
	"time"

	wire "github.com/go-mysql-org/go-mysql/mysql"
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

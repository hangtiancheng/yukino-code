package postgres

import (
	"encoding/json"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
)

func TestDefaultPGValueParsers(t *testing.T) {
	for _, test := range []struct {
		oid       uint32
		raw, want string
	}{
		{23, "1", `1`}, {16, "t", `true`}, {20, "9007199254740993", `"9007199254740993"`},
		{1700, "12.50", `"12.50"`}, {700, "0.1", `0.1`}, {701, "NaN", `null`},
		{3802, `{"a":1}`, `{"a":1}`}, {17, `\x00ff`, `{"data":[0,255],"type":"Buffer"}`},
		{1007, `{{1,NULL},{2,3}}`, `[[1,null],[2,3]]`},
		{1009, `{"NULL",NULL,"a,b","c\"d"}`, `["NULL",null,"a,b","c\"d"]`},
		{1016, `{1,9007199254740993}`, `["1","9007199254740993"]`},
		{1231, `{12.50,NaN}`, `[12.5,null]`}, {999999, "opaque", `"opaque"`},
	} {
		value, err := decodeText(pgtype.NewMap(), test.oid, []byte(test.raw))
		if err != nil {
			t.Fatalf("OID %d: %v", test.oid, err)
		}
		raw, err := json.Marshal(value)
		if err != nil || string(raw) != test.want {
			t.Errorf("OID %d: %s (%v), want %s", test.oid, raw, err, test.want)
		}
	}
	if rowCount(pgconn.NewCommandTag("CREATE TABLE")) != nil || rowCount(pgconn.NewCommandTag("UPDATE 0")) != int64(0) {
		t.Fatal("DDL/count semantics differ from pg")
	}
}

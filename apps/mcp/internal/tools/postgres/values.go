package postgres

import (
	"encoding/json"
	"fmt"
	"math"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
)

// pg's default parsers keep int8/numeric/unknown types as text, decode JSON and
// ordinary numbers, and serialize dates and bytea through JSON's Date/Buffer
// representations. Both Go query paths use the same policy.
func decodeText(types *pgtype.Map, oid uint32, raw []byte) (any, error) {
	if raw == nil {
		return nil, nil
	}
	if element, ok := arrayElementOID[oid]; ok {
		return decodeArray(types, element, string(raw))
	}
	switch oid {
	case pgtype.Int8OID, pgtype.NumericOID:
		return string(raw), nil
	case pgtype.JSONOID, pgtype.JSONBOID:
		var value any
		err := json.Unmarshal(raw, &value)
		return value, err
	case pgtype.Float4OID, pgtype.Float8OID:
		value, err := strconv.ParseFloat(string(raw), 64)
		return normalizeDecoded(value), err
	case pgtype.BoolOID, pgtype.Int2OID, pgtype.Int4OID, pgtype.OIDOID,
		pgtype.DateOID, pgtype.TimestampOID, pgtype.TimestamptzOID, pgtype.ByteaOID, pgtype.IntervalOID, pgtype.PointOID, pgtype.CircleOID:
		typ, _ := types.TypeForOID(oid)
		value, err := typ.Codec.DecodeValue(types, oid, pgtype.TextFormatCode, raw)
		if err != nil {
			return nil, err
		}
		if date, ok := value.(time.Time); ok && (oid == pgtype.DateOID || oid == pgtype.TimestampOID) {
			value = time.Date(date.Year(), date.Month(), date.Day(), date.Hour(), date.Minute(), date.Second(), date.Nanosecond(), time.Local)
		}
		return normalizeDecoded(value), nil
	default:
		return string(raw), nil
	}
}

func normalizeDecoded(value any) any {
	switch v := value.(type) {
	case time.Time:
		return v.UTC().Format("2006-01-02T15:04:05.000Z")
	case []byte:
		data := make([]int, len(v))
		for i, b := range v {
			data[i] = int(b)
		}
		return map[string]any{"type": "Buffer", "data": data}
	case float32:
		if math.IsNaN(float64(v)) || math.IsInf(float64(v), 0) {
			return nil
		}
	case float64:
		if math.IsNaN(v) || math.IsInf(v, 0) {
			return nil
		}
	case pgtype.InfinityModifier:
		return nil
	case pgtype.Interval:
		result := map[string]any{}
		for name, amount := range map[string]any{
			"years": v.Months / 12, "months": v.Months % 12, "days": v.Days,
			"hours": v.Microseconds / 3600000000, "minutes": (v.Microseconds / 60000000) % 60,
			"seconds": float64(v.Microseconds%60000000) / 1000000,
		} {
			if amount != int32(0) && amount != int64(0) && amount != float64(0) {
				result[name] = amount
			}
		}
		return result
	case pgtype.Point:
		return map[string]any{"x": v.P.X, "y": v.P.Y}
	case pgtype.Circle:
		return map[string]any{"x": v.P.X, "y": v.P.Y, "radius": v.R}
	}
	return value
}

var arrayElementOID = map[uint32]uint32{
	1000: pgtype.BoolOID, 1001: pgtype.ByteaOID, 1005: pgtype.Int2OID, 1007: pgtype.Int4OID,
	1016: pgtype.Int8OID, 1028: pgtype.OIDOID, 1021: pgtype.Float4OID, 1022: pgtype.Float8OID,
	1002: 18, 1003: pgtype.NameOID, 1009: pgtype.TextOID, 1014: pgtype.BPCharOID, 1015: pgtype.VarcharOID,
	1115: pgtype.TimestampOID, 1182: pgtype.DateOID, 1185: pgtype.TimestamptzOID,
	199: pgtype.JSONOID, 3807: pgtype.JSONBOID, 1231: pgtype.NumericOID,
	2951: pgtype.UUIDOID, 651: pgtype.CIDROID, 1041: pgtype.InetOID,
}

func decodeArray(types *pgtype.Map, element uint32, text string) (any, error) {
	// pg's array parser ignores explicit lower bounds but retains nesting.
	if strings.HasPrefix(text, "[") {
		if i := strings.IndexByte(text, '='); i >= 0 {
			text = text[i+1:]
		}
	}
	index := 0
	var parse func() ([]any, error)
	parse = func() ([]any, error) {
		if index >= len(text) || text[index] != '{' {
			return nil, fmt.Errorf("invalid PostgreSQL array")
		}
		index++
		out := []any{}
		for index < len(text) && text[index] != '}' {
			var value any
			var err error
			if text[index] == '{' {
				value, err = parse()
			} else {
				quoted := text[index] == '"'
				if quoted {
					index++
				}
				var entry strings.Builder
				for index < len(text) {
					ch := text[index]
					if ch == '\\' && index+1 < len(text) {
						index++
						entry.WriteByte(text[index])
						index++
						continue
					}
					if quoted && ch == '"' {
						index++
						break
					}
					if !quoted && (ch == ',' || ch == '}') {
						break
					}
					entry.WriteByte(ch)
					index++
				}
				if quoted || entry.String() != "NULL" {
					if element == pgtype.NumericOID {
						var number float64
						number, err = strconv.ParseFloat(entry.String(), 64)
						value = normalizeDecoded(number)
					} else {
						value, err = decodeText(types, element, []byte(entry.String()))
					}
				}
			}
			if err != nil {
				return nil, err
			}
			out = append(out, value)
			if index < len(text) && text[index] == ',' {
				index++
			} else if index >= len(text) || text[index] != '}' {
				return nil, fmt.Errorf("invalid PostgreSQL array")
			}
		}
		if index >= len(text) {
			return nil, fmt.Errorf("unterminated PostgreSQL array")
		}
		index++
		return out, nil
	}
	return parse()
}

func rowCount(tag pgconn.CommandTag) any {
	words := strings.Fields(tag.String())
	if len(words) > 1 {
		if count, err := strconv.ParseInt(words[len(words)-1], 10, 64); err == nil {
			return count
		}
	}
	return nil
}

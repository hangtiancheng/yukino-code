package operations

import (
	"math"
	"testing"
)

func TestUnserializableResultIsError(t *testing.T) {
	res := Result(map[string]any{"value": math.NaN()})
	if !res.IsError || res.StructuredContent != nil {
		t.Fatalf("serialization failure reported as success: %+v", res)
	}
}

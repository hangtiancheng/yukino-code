package history

import (
	"bytes"
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
)

type CommandUsageSnapshot struct {
	Entries map[string]CommandUsage
	Order   []string
}

func objectKeys(raw []byte) ([]string, error) {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	if token, err := decoder.Token(); err != nil || token != json.Delim('{') {
		return nil, fmt.Errorf("expected JSON object")
	}
	keys := []string{}
	seen := map[string]bool{}
	for decoder.More() {
		token, err := decoder.Token()
		if err != nil {
			return nil, err
		}
		key, ok := token.(string)
		if !ok {
			return nil, fmt.Errorf("expected object key")
		}
		var value json.RawMessage
		if err := decoder.Decode(&value); err != nil {
			return nil, err
		}
		if !seen[key] {
			keys = append(keys, key)
			seen[key] = true
		}
	}
	return jsObjectOrder(keys), nil
}

func jsObjectOrder(keys []string) []string {
	keys = append([]string(nil), keys...)
	index := func(key string) (uint64, bool) {
		n, err := strconv.ParseUint(key, 10, 32)
		return n, err == nil && n < 4294967295 && strconv.FormatUint(n, 10) == key
	}
	sort.SliceStable(keys, func(i, j int) bool {
		a, aIndex := index(keys[i])
		b, bIndex := index(keys[j])
		if aIndex != bIndex {
			return aIndex
		}
		return aIndex && a < b
	})
	return keys
}

func marshalCheckpoint(record checkpointRecord, order []string) ([]byte, error) {
	var usage bytes.Buffer
	usage.WriteByte('{')
	for i, key := range jsObjectOrder(order) {
		if i > 0 {
			usage.WriteByte(',')
		}
		encoded, err := json.Marshal(key)
		if err != nil {
			return nil, err
		}
		usage.Write(encoded)
		usage.WriteByte(':')
		encoded, err = json.Marshal(record.CommandUsage[key])
		if err != nil {
			return nil, err
		}
		usage.Write(encoded)
	}
	usage.WriteByte('}')
	return json.Marshal(struct {
		Type         string                 `json:"type"`
		Projects     map[string]ProjectInfo `json:"projects"`
		Inputs       []InputEntry           `json:"inputs"`
		CommandUsage json.RawMessage        `json:"commandUsage"`
	}{record.Type, record.Projects, record.Inputs, usage.Bytes()})
}

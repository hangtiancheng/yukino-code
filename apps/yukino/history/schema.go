package history

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"regexp"
	"strconv"
)

var inputIDPattern = regexp.MustCompile(`(?i)^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$`)

func normalizeActivityNumbers(raw []byte, kind string) ([]byte, error) {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil {
		return nil, err
	}
	if fields == nil {
		return nil, errors.New("expected activity record object")
	}
	integer := func(key string) error {
		value, ok := fields[key]
		if !ok {
			return nil
		}
		value = bytes.TrimSpace(value)
		if len(value) == 0 || value[0] != '-' && (value[0] < '0' || value[0] > '9') {
			return fmt.Errorf("invalid integer %s", key)
		}
		n, err := strconv.ParseFloat(string(value), 64)
		if err != nil || math.IsNaN(n) || math.IsInf(n, 0) || math.Trunc(n) != n || math.Abs(n) > 9007199254740991 {
			return fmt.Errorf("invalid integer %s", key)
		}
		fields[key] = []byte(strconv.FormatInt(int64(n), 10))
		return nil
	}
	switch kind {
	case "project":
		if err := integer("createdAt"); err != nil {
			return nil, err
		}
	case "input":
		if err := integer("timestamp"); err != nil {
			return nil, err
		}
	case "usage":
		for _, key := range []string{"usageCount", "lastUsedAt"} {
			if err := integer(key); err != nil {
				return nil, err
			}
		}
	case "checkpoint":
		for _, key := range []string{"projects", "commandUsage"} {
			if _, ok := fields[key]; !ok {
				continue
			}
			var records map[string]json.RawMessage
			if err := json.Unmarshal(fields[key], &records); err != nil {
				return nil, err
			}
			nestedKind := "project"
			if key == "commandUsage" {
				nestedKind = "usage"
			}
			for name, value := range records {
				normalized, err := normalizeActivityNumbers(value, nestedKind)
				if err != nil {
					return nil, err
				}
				records[name] = normalized
			}
			if records != nil {
				encoded, err := json.Marshal(records)
				if err != nil {
					return nil, err
				}
				fields[key] = encoded
			}
		}
		if value, ok := fields["inputs"]; ok {
			var inputs []json.RawMessage
			if err := json.Unmarshal(value, &inputs); err != nil {
				return nil, err
			}
			for i, input := range inputs {
				normalized, err := normalizeActivityNumbers(input, "input")
				if err != nil {
					return nil, err
				}
				inputs[i] = normalized
			}
			if inputs != nil {
				encoded, err := json.Marshal(inputs)
				if err != nil {
					return nil, err
				}
				fields["inputs"] = encoded
			}
		}
	}
	return json.Marshal(fields)
}

func decodeRecordFields(raw []byte, required []string, strict bool) (map[string]json.RawMessage, error) {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil {
		return nil, err
	}
	if fields == nil {
		return nil, errors.New("expected activity record object")
	}
	allowed := make(map[string]bool, len(required))
	for _, key := range required {
		if _, ok := fields[key]; !ok {
			return nil, fmt.Errorf("missing field %s", key)
		}
		allowed[key] = true
	}
	for key, value := range fields {
		if strict && !allowed[key] {
			return nil, fmt.Errorf("unrecognized field %s", key)
		}
		if allowed[key] && bytes.Equal(bytes.TrimSpace(value), []byte("null")) && key != "sessionId" && key != "commandName" {
			return nil, fmt.Errorf("invalid null field %s", key)
		}
	}
	return fields, nil
}

func validateProjectShape(raw []byte, record bool) error {
	keys := []string{"projectKey", "cwd", "createdAt"}
	if record {
		keys = append(keys, "type")
	}
	if _, err := decodeRecordFields(raw, keys, true); err != nil {
		return err
	}
	var project ProjectInfo
	if err := json.Unmarshal(raw, &project); err != nil {
		return err
	}
	return validateProjectFields(project)
}

func validateInputShape(raw []byte) error {
	if _, err := decodeRecordFields(raw, []string{"type", "id", "timestamp", "cwd", "sessionId", "source", "text", "commandName"}, true); err != nil {
		return err
	}
	var input InputEntry
	if err := json.Unmarshal(raw, &input); err != nil {
		return err
	}
	return validateInput(input)
}

func validateCheckpointShape(raw []byte) error {
	fields, err := decodeRecordFields(raw, []string{"type", "projects", "inputs", "commandUsage"}, false)
	if err != nil {
		return err
	}
	var projects map[string]json.RawMessage
	if err := json.Unmarshal(fields["projects"], &projects); err != nil {
		return err
	}
	for _, value := range projects {
		if err := validateProjectShape(value, false); err != nil {
			return err
		}
	}
	var inputs []json.RawMessage
	if err := json.Unmarshal(fields["inputs"], &inputs); err != nil {
		return err
	}
	if len(inputs) > MaxHistoryEntries {
		return errors.New("too many checkpoint inputs")
	}
	for _, value := range inputs {
		if err := validateInputShape(value); err != nil {
			return err
		}
	}
	var usage map[string]json.RawMessage
	if err := json.Unmarshal(fields["commandUsage"], &usage); err != nil {
		return err
	}
	for _, value := range usage {
		if _, err := decodeRecordFields(value, []string{"usageCount", "lastUsedAt"}, true); err != nil {
			return err
		}
		var entry CommandUsage
		if err := json.Unmarshal(value, &entry); err != nil {
			return err
		}
		if entry.UsageCount < 0 || uint64(entry.UsageCount) > 9007199254740991 || entry.LastUsedAt < 0 || entry.LastUsedAt > 9007199254740991 {
			return errors.New("invalid command usage")
		}
	}
	return nil
}

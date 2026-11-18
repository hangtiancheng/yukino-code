package remote

import (
	"encoding/base64"
	"encoding/json"
	"math"
	"strings"
)

type wsField struct {
	optional bool
	valid    func(json.RawMessage) bool
}

func wsString(raw json.RawMessage) bool {
	var value string
	return len(raw) > 0 && raw[0] == '"' && json.Unmarshal(raw, &value) == nil
}

func wsEnum(values ...string) func(json.RawMessage) bool {
	return func(raw json.RawMessage) bool {
		var value string
		if !wsString(raw) || json.Unmarshal(raw, &value) != nil {
			return false
		}
		for _, allowed := range values {
			if value == allowed {
				return true
			}
		}
		return false
	}
}

var wsDataSchemas = map[string]map[string]wsField{
	"user_message":        {"content": {valid: wsString}},
	"permission_response": {"id": {valid: wsString}, "response": {valid: wsEnum("allow", "deny", "allowAlways")}},
	"ask_user_response": {"id": {valid: wsString}, "answers": {valid: func(raw json.RawMessage) bool {
		var answers map[string]json.RawMessage
		if json.Unmarshal(raw, &answers) != nil || answers == nil {
			return false
		}
		for _, answer := range answers {
			if !wsString(answer) {
				return false
			}
		}
		return true
	}}},
	"plan_approval_response": {"id": {valid: wsString}, "choice": {valid: wsEnum("yolo", "manual", "feedback")}, "feedback": {optional: true, valid: wsString}},
	"set_permission_mode":    {"mode": {valid: wsEnum("default", "acceptEdits", "bypassPermissions", "plan")}},
	"model_select":           {"model": {valid: wsString}},
	"provider_select": {"index": {valid: func(raw json.RawMessage) bool {
		var value float64
		return string(raw) != "null" && json.Unmarshal(raw, &value) == nil && value >= 0 && value <= 9007199254740991 && math.Trunc(value) == value
	}}},
	"provider_save": {
		"name": {valid: wsString}, "protocol": {valid: wsEnum("anthropic", "openai", "openai-compat")},
		"base_url": {valid: wsString}, "api_key": {optional: true, valid: wsString}, "model": {valid: wsString},
		"thinking": {optional: true, valid: wsEnum("off", "minimal", "low", "medium", "high", "xhigh", "max")},
	},
	"rewind_action":         {"snapshotId": {valid: wsString}, "action": {valid: wsEnum("code_and_conversation", "conversation_only", "code_only")}},
	"file_complete_request": {"requestId": {valid: wsString}, "query": {valid: wsString}},
	"image_upload":          {"clientId": {valid: wsString}, "name": {valid: wsString}, "dataBase64": {valid: wsString}},
}

func parseClientMessage(raw []byte) (clientMessage, bool) {
	var envelope map[string]json.RawMessage
	var msg clientMessage
	if json.Unmarshal(raw, &envelope) != nil || !wsString(envelope["type"]) || json.Unmarshal(raw, &msg) != nil {
		return msg, false
	}
	if _, present := envelope["data"]; !present {
		return msg, false
	}
	schema, constrained := wsDataSchemas[msg.Type]
	if !constrained {
		return msg, true
	}
	var data map[string]json.RawMessage
	if json.Unmarshal(msg.Data, &data) != nil || data == nil {
		return msg, false
	}
	clean := make(map[string]json.RawMessage, len(schema))
	for name, field := range schema {
		value, present := data[name]
		if !present && field.optional {
			continue
		}
		if !field.valid(value) {
			return msg, false
		}
		clean[name] = value
	}
	msg.Data, _ = json.Marshal(clean)
	return msg, true
}

func decodeUploadBase64(value string) []byte {
	var encoded strings.Builder
	for index := 0; index < len(value); index++ {
		char := value[index]
		if char == '=' {
			break
		}
		switch char {
		case '-':
			char = '+'
		case '_':
			char = '/'
		}
		if char >= 'A' && char <= 'Z' || char >= 'a' && char <= 'z' || char >= '0' && char <= '9' || char == '+' || char == '/' {
			encoded.WriteByte(char)
		}
	}
	text := encoded.String()
	if len(text)%4 == 1 {
		text = text[:len(text)-1]
	}
	decoded, _ := base64.RawStdEncoding.DecodeString(text)
	return decoded
}

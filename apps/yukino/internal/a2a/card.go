package a2a

import (
	"net/url"

	a2alib "github.com/a2aproject/a2a-go/a2a"

	"github.com/yukino-js/yukino/yukino/internal/version"
)

// Permission extension parameter schemas, byte-identical to
// z.toJSONSchema(PermissionRequestDataSchema) and
// z.toJSONSchema(PermissionResponseDataSchema) in the reference.
var permissionRequestSchema = map[string]any{
	"$schema": "https://json-schema.org/draft/2020-12/schema",
	"type":    "object",
	"properties": map[string]any{
		"yukino":       map[string]any{"type": "string", "const": "permission-request"},
		"permissionId": map[string]any{"type": "string"},
		"toolCallId":   map[string]any{"type": "string"},
		"toolName":     map[string]any{"type": "string"},
		"reason":       map[string]any{"type": "string"},
		"args":         map[string]any{"type": "object", "propertyNames": map[string]any{"type": "string"}, "additionalProperties": map[string]any{}},
		"source": map[string]any{
			"type": "object",
			"properties": map[string]any{
				"agentName": map[string]any{"type": "string"},
				"cwd":       map[string]any{"type": "string"},
			},
			"required":             []string{"agentName", "cwd"},
			"additionalProperties": false,
		},
	},
	"required":             []string{"yukino", "permissionId", "toolCallId", "toolName", "reason", "args"},
	"additionalProperties": false,
}

var permissionResponseSchema = map[string]any{
	"$schema": "https://json-schema.org/draft/2020-12/schema",
	"type":    "object",
	"properties": map[string]any{
		"yukino":       map[string]any{"type": "string", "const": "permission-response"},
		"permissionId": map[string]any{"type": "string"},
		"decision":     map[string]any{"type": "string", "enum": []string{"allow", "deny", "allowAlways"}},
	},
	"required":             []string{"yukino", "permissionId", "decision"},
	"additionalProperties": false,
}

// BuildAgentCard builds the agent card for the given base URL. Both the
// JSON-RPC endpoint (POST /) and the HTTP+JSON/REST endpoints (/v1/...) are
// served from the same origin. The REST interface includes its /v1/ route
// prefix.
func BuildAgentCard(baseURL string) *a2alib.AgentCard {
	restURL := baseURL
	if u, err := url.Parse(baseURL); err == nil {
		restURL = u.JoinPath("v1/").String()
	}
	interfaces := []*a2alib.AgentInterface{
		{
			URL:             baseURL,
			ProtocolBinding: a2alib.TransportProtocolJSONRPC,
			ProtocolVersion: A2AProtocolVersion,
		},
		{
			URL:             restURL,
			ProtocolBinding: a2alib.TransportProtocolHTTPJSON,
			ProtocolVersion: A2AProtocolVersion,
		},
	}
	return &a2alib.AgentCard{
		Name:                "yukino",
		Description:         Description,
		SupportedInterfaces: interfaces,
		Version:             version.Version,
		Capabilities: a2alib.AgentCapabilities{
			Streaming: true,
			Extensions: []a2alib.AgentExtension{
				{
					URI:         PermissionExtensionURI,
					Description: PermissionExtensionDescription,
					Required:    false,
					Params: map[string]any{
						"decisions":      []string{"allow", "deny", "allowAlways"},
						"versionHeader":  "A2A-Version: 1.0",
						"requestSchema":  permissionRequestSchema,
						"responseSchema": permissionResponseSchema,
					},
				},
			},
		},
		DefaultInputModes:  []string{"text/plain"},
		DefaultOutputModes: []string{"text/plain"},
		Skills: []a2alib.AgentSkill{
			{
				ID:          "coding",
				Name:        "Coding",
				Description: SkillDescription,
				Tags:        []string{"code", "development", "programming"},
				Examples:    SkillExamples,
				InputModes:  []string{"text/plain"},
				OutputModes: []string{"text/plain"},
			},
		},
	}
}

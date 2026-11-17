// Package a2a mirrors src/a2a: the A2A protocol server bridging external
// agents to the yukino agent loop.
package a2a

import (
	"encoding/json"
	"fmt"
	"time"
)

// YukinoDataKey is the discriminator key inside structured data parts owned
// by yukino.
const YukinoDataKey = "yukino"

// Discriminator values identifying the yukino data part kinds.
const (
	PermissionRequestKind  = "permission-request"
	PermissionResponseKind = "permission-response"
	ThinkingKind           = "thinking"
	ToolCallKind           = "tool-call"
	ToolResultKind         = "tool-result"
)

// MaxToolOutputLength: tool result outputs above this length are truncated in
// published events.
const MaxToolOutputLength = 8000

// TruncationMarker is appended to tool outputs truncated in published events.
const TruncationMarker = "\n… [truncated]"

// DefaultIdleTimeout is the idle grace period before an agent runtime is
// disposed to reclaim resources.
const DefaultIdleTimeout = 30 * 60 * time.Second

// MaxTrackedSessions is the upper bound on tracked contextId sessions. Idle
// eviction releases a session's runtime but keeps its contextId→sessionId
// entry so the transcript can be restored; without a cap a long-running
// server seeing many distinct contextIds would grow that map until dispose.
// Overflow drops the least-recently-used fully-idle entries after persisting
// their context mapping.
const MaxTrackedSessions = 256

const NoActiveRun = "No active run is awaiting a permission response."

const MessageContentRequired = "Message must contain text or a yukino permission-response data part."

const SessionClosedDuringInit = "Session closed during initialization."

const TaskCanceledText = "Task canceled by user request."

func BuildContextBusyReason(contextID, taskID string) string {
	return fmt.Sprintf("Context %s is busy with task %s. Cancel it or wait for it to finish before sending a new message.", contextID, taskID)
}

func BuildPermissionTaskMismatchReason(taskID string) string {
	return fmt.Sprintf("Permission responses must be sent with taskId %q.", taskID)
}

func BuildUnknownPermissionIDReason(permissionID string) string {
	return fmt.Sprintf("Unknown or already resolved permission id %q.", permissionID)
}

const TranscriptUnavailableError = "A2A context transcript is no longer available. Start a new context."

const SessionCapacityError = "A2A session capacity reached; retry when an active context finishes."

const InvalidContextMappingError = "Invalid persisted A2A context mapping."

const LoopbackRequiredError = "A2A server must listen on a loopback address."

const ServerNotBoundError = "A2A server did not bind to a TCP address."

const A2ADefaultPort = 18890
const DefaultAddress = "127.0.0.1:18890"
const AgentCardPath = "/.well-known/agent-card.json"
const A2AProtocolVersion = "1.0"
const A2AContextsDirName = "a2a-contexts"

const DefaultHistoryLength = 10
const RequestBodyLimit = 100 * 1024
const PermissionExtensionURI = "https://github.com/hangtiancheng/yukino-code/blob/main/packages/yukino/README.md#yukino-a2a-permissions-v1"

// A2AMethods is the JSON-RPC method allowlist advertised in unknown-method
// errors, in reference order.
var A2AMethods = []string{
	"SendMessage",
	"SendStreamingMessage",
	"GetTask",
	"ListTasks",
	"CancelTask",
	"SubscribeToTask",
	"CreateTaskPushNotificationConfig",
	"GetTaskPushNotificationConfig",
	"ListTaskPushNotificationConfigs",
	"DeleteTaskPushNotificationConfig",
	"GetExtendedAgentCard",
}

var a2aMethodSet = func() map[string]bool {
	set := make(map[string]bool, len(A2AMethods))
	for _, method := range A2AMethods {
		set[method] = true
	}
	return set
}()

const MissingVersionError = "Missing A2A-Version header; send A2A-Version: 1.0."

var RequestTooLargeError = fmt.Sprintf("Request body exceeds the %d byte limit.", RequestBodyLimit)

const MalformedJSONError = "Request body must contain valid JSON."

func UnsupportedVersionError(version string) string {
	return fmt.Sprintf("Unsupported A2A-Version %s; this server requires A2A-Version: 1.0.", jsonQuote(version))
}

func UnknownMethodError(method string) string {
	joined := ""
	for i, m := range A2AMethods {
		if i > 0 {
			joined += ", "
		}
		joined += m
	}
	return fmt.Sprintf("Unknown method %s. Supported methods: %s.", jsonQuote(method), joined)
}

// jsonQuote renders a JSON string literal, mirroring JSON.stringify.
func jsonQuote(s string) string {
	b, _ := json.Marshal(s)
	return string(b)
}

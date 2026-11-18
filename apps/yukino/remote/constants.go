package remote

// LoopbackHosts are the hosts considered loopback for bind validation,
// mirroring LOOPBACK_HOSTS in src/remote/constants.ts.
var LoopbackHosts = map[string]bool{
	"127.0.0.1": true,
	"::1":       true,
	"localhost": true,
}

// TextPreviewChars caps the text preview attached to structured event logs.
const TextPreviewChars = 800

// PendingRequestTimeoutMS settles permission/ask requests with no client response.
const PendingRequestTimeoutMS = 10 * 60 * 1000

const PendingRequestTimeoutMinutes = 10

// WS heartbeat: ping interval and the no-pong threshold that terminates a
// half-open connection, mirroring HEARTBEAT_INTERVAL_MS/HEARTBEAT_STALE_MS.
const HeartbeatIntervalMS = 30_000
const HeartbeatStaleMS = 75_000

// InputHistoryLimit caps the recent input-history entries replayed to a newly
// connected browser, mirroring INPUT_HISTORY_LIMIT.
const InputHistoryLimit = 200

// FileCacheTTLMS is the @-mention file cache lifetime, mirroring
// FILE_CACHE_TTL_MS (matches the terminal input cache).
const FileCacheTTLMS = 30_000

// MaxUploadImageBytes caps uploaded images, mirroring MAX_UPLOAD_IMAGE_BYTES
// (the terminal clipboard-image limit).
const MaxUploadImageBytes = 32 * 1024 * 1024

// SessionListLimit caps the sessions offered by the /resume picker, mirroring
// SESSION_LIST_LIMIT.
const SessionListLimit = 50

// Activity-bridge cadence: teammate-state diffing and the idle wakeup that
// drains pending task notifications, mirroring TEAMMATE_POLL_INTERVAL_MS and
// WAKEUP_POLL_INTERVAL_MS.
const TeammatePollIntervalMS = 500
const WakeupPollIntervalMS = 250

// ShutdownGraceMS is the delay between the /quit acknowledgement and the
// actual shutdown, mirroring SHUTDOWN_GRACE_MS.
const ShutdownGraceMS = 250

package vscode

import "time"

const (
	StartTimeoutMS = 10_000

	ClaudeCodeSSEPortEnvVar = "CLAUDE_CODE_SSE_PORT"
	ClaudeConfigDirEnvVar   = "CLAUDE_CONFIG_DIR"
	TermProgramEnvVar       = "TERM_PROGRAM"
	TermProgramVscode       = "vscode"

	DefaultConfigDirName = ".claude"
	IdeLockDirName       = "ide"
	LockfileExtension    = ".lock"
	LockfileWsTransport  = "ws"
	DefaultIdeName       = "IDE"
	IdeWsHost            = "127.0.0.1"

	IdeAuthHeader      = "X-Claude-Code-Ide-Authorization"
	IdeConnectedMethod = "ide_connected"
	MCPWsSubprotocol   = "mcp"

	IdeDetectTimeoutMS      = 30_000
	IdeDetectPollIntervalMS = 1_000
)

const (
	StartTimeout          = StartTimeoutMS * time.Millisecond
	IdeDetectTimeout      = IdeDetectTimeoutMS * time.Millisecond
	IdeDetectPollInterval = IdeDetectPollIntervalMS * time.Millisecond
)

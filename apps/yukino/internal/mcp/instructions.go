package mcp

import (
	"sort"

	"github.com/yukino-js/yukino/yukino/internal/conversation"
)

// Announces MCP server instructions as deltas.
//
// Server instructions are guidance the model cannot derive from a tool schema,
// so they have to reach the conversation. The announcement is incremental:
// newly connected servers are added, and servers whose instructions were
// announced but are no longer connected are retracted. History is the source of
// truth for what was announced: /clear, /resume and compaction all drop the
// reminder, and once the marker is gone nothing is announced any more, so
// everything has to go out again.

type McpInstruction struct {
	ServerName string
	Text       string
}

// McpInstructionSource is the part of Manager this module needs, so tests can
// stand in for it.
type McpInstructionSource interface {
	ConnectedServers() []string
	ConnectedInstructions() []McpInstruction
}

// ReminderHistory is the part of conversation.Manager this module needs.
type ReminderHistory interface {
	HasReminderContaining(marker string) bool
	AddSystemReminder(content string)
}

// SyncMcpInstructions injects the delta between what the model has been told
// and what is connected now. It reports whether a reminder was appended.
func SyncMcpInstructions(history ReminderHistory, announced map[string]bool, source McpInstructionSource) bool {
	if !history.HasReminderContaining(MCPInstructionsMarker) {
		clear(announced)
	}

	live := map[string]bool{}
	for _, name := range source.ConnectedServers() {
		live[name] = true
	}
	var added []McpInstruction
	for _, instruction := range source.ConnectedInstructions() {
		if !announced[instruction.ServerName] {
			added = append(added, instruction)
		}
	}
	sort.SliceStable(added, func(i, j int) bool {
		return added[i].ServerName < added[j].ServerName
	})
	var removed []string
	for name := range announced {
		if !live[name] {
			removed = append(removed, name)
		}
	}
	sort.Strings(removed)

	if len(added) == 0 && len(removed) == 0 {
		return false
	}
	for _, instruction := range added {
		announced[instruction.ServerName] = true
	}
	for _, name := range removed {
		delete(announced, name)
	}

	history.AddSystemReminder(FormatMcpInstructionsDelta(added, removed))
	return true
}

func RetractMcpInstructions(history ReminderHistory, announced map[string]bool) bool {
	return SyncMcpInstructions(history, announced, emptyInstructionSource{})
}

type emptyInstructionSource struct{}

func (emptyInstructionSource) ConnectedServers() []string              { return nil }
func (emptyInstructionSource) ConnectedInstructions() []McpInstruction { return nil }

var (
	_ ReminderHistory      = (*conversation.Manager)(nil)
	_ McpInstructionSource = (*Manager)(nil)
)

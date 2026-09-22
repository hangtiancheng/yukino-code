// Copyright (c) 2026 hangtiancheng
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

package mcp

import (
	"fmt"
	"sort"
	"strings"

	"golang.org/x/text/collate"
	"golang.org/x/text/language"
)

// Announces MCP server instructions as deltas.
//
// Server instructions are guidance the model cannot derive from a tool schema,
// so they have to reach the conversation. Re-sending a full snapshot on every
// connect pass repeats that guidance — a few hundred tokens per pass — and the
// system prompt cannot carry it either: tools and history follow the system
// prompt, so a late MCP connect would invalidate the cached prefix of the
// whole conversation.
//
// So the announcement is incremental: newly connected servers are added, and
// servers whose instructions were announced but are no longer connected are
// retracted. Which servers were announced lives in the caller (a map), but
// history is the source of truth for it: /clear, /resume and compaction all
// drop the reminder, and once the marker is gone from history nothing is
// announced any more, so everything has to go out again.

// InstructionsMarker is the heading every announcement carries; also the
// marker history is scanned for.
const InstructionsMarker = "# MCP Server Instructions"

// InstructionsSource is the part of Manager this module needs, so tests can
// stand in for it.
type InstructionsSource interface {
	ConnectedServers() []ServerInfo
}

// ReminderHistory is the part of conversation.Manager this module needs.
type ReminderHistory interface {
	HasReminderContaining(marker string) bool
	AddSystemReminder(content string)
}

// SyncInstructions injects the delta between what the model has been told and
// what is connected now. Returns true when a reminder was appended, false
// when nothing changed.
func SyncInstructions(history ReminderHistory, announced map[string]bool, source InstructionsSource) bool {
	if !history.HasReminderContaining(InstructionsMarker) {
		for name := range announced {
			delete(announced, name)
		}
	}

	servers := source.ConnectedServers()
	live := make(map[string]bool, len(servers))
	var added []ServerInfo
	for _, srv := range servers {
		live[srv.Name] = true
		if srv.Instructions == "" || announced[srv.Name] {
			continue
		}
		added = append(added, srv)
	}
	// TS sorts the added servers with localeCompare (ICU root collation:
	// case-insensitive primary order, lowercase before uppercase on ties),
	// not by code units — a plain byte sort would order "Zebra" before
	// "apple". The collator is created per call because collate.Collator is
	// not safe for concurrent use.
	locale := collate.New(language.Und)
	sort.SliceStable(added, func(i, j int) bool {
		return locale.CompareString(added[i].Name, added[j].Name) < 0
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
	for _, srv := range added {
		announced[srv.Name] = true
	}
	for _, name := range removed {
		delete(announced, name)
	}

	history.AddSystemReminder(formatInstructionsDelta(added, removed))
	return true
}

func formatInstructionsDelta(added []ServerInfo, removed []string) string {
	var parts []string
	if len(added) > 0 {
		blocks := make([]string, 0, len(added))
		for _, srv := range added {
			blocks = append(blocks, fmt.Sprintf("## %s\n%s", srv.Name, srv.Instructions))
		}
		parts = append(parts, InstructionsMarker+"\n\nThe following MCP servers have provided instructions for how to use their tools and resources:\n\n"+
			strings.Join(blocks, "\n\n"))
	}
	if len(removed) > 0 {
		parts = append(parts, "The following MCP servers have disconnected. Their instructions above no longer apply:\n"+
			strings.Join(removed, "\n"))
	}
	return strings.Join(parts, "\n\n")
}

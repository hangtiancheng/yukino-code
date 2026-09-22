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

package subagent

import (
	"strings"

	"github.com/hangtiancheng/yukino-code/yukino/tools"
)

// AllAgentDisallowedTools lists tools that no sub-agent may use; even an agent
// definition's allowlist cannot enable them. Mirrors the TS
// SUBAGENT_DISALLOWED_TOOLS = MAIN_AGENT_ONLY_TOOLS (ComputerUse,
// AskUserQuestion, ExitPlanMode) plus delegation-policy restrictions (Agent,
// TaskStop). ComputerUse drives the single physical screen/mouse/keyboard, so a
// delegated agent must never operate it.
var AllAgentDisallowedTools = map[string]bool{
	"ComputerUse":     true,
	"AskUserQuestion": true,
	"ExitPlanMode":    true,
	"Agent":           true,
	"TaskStop":        true,
}

// MainAgentOnlyTools mirrors the TS MAIN_AGENT_ONLY_TOOLS: tools that depend on
// main-thread UI state or a singleton device and are stripped from every
// delegated agent, including forks (cloneRegistryForFork).
var MainAgentOnlyTools = map[string]bool{
	"ComputerUse":     true,
	"AskUserQuestion": true,
	"ExitPlanMode":    true,
}

// CustomAgentDisallowedTools mirrors the TS CUSTOM_AGENT_DISALLOWED_TOOLS:
// additional restrictions for agents loaded from .yukino/agents/. ComputerUse
// is omitted because Layer 2 already strips it.
var CustomAgentDisallowedTools = map[string]bool{
	"ExitPlanMode":    true,
	"Agent":           true,
	"AskUserQuestion": true,
	"TaskStop":        true,
}

// AsyncAgentAllowedTools mirrors the TS ASYNC_AGENT_ALLOWED_TOOLS: the exact
// set background (async) agents may use. No Agent (no nested spawn), no
// TaskStop, no ExitPlanMode.
var AsyncAgentAllowedTools = map[string]bool{
	"ReadFile":        true,
	"Grep":            true,
	"Glob":            true,
	"Bash":            true,
	"PowerShell":      true,
	"EditFile":        true,
	"WriteFile":       true,
	"LoadSkill":       true,
	"SyntheticOutput": true,
	"ToolSearch":      true,
	"EnterWorktree":   true,
	"ExitWorktree":    true,
	// ToolSearch only reads schemas; actual invocation requires McpCall.
	// Both must be allowed together, otherwise the sub-agent can see tools
	// but cannot call them.
	"McpCall": true,
}

// TeammateDisallowedTools lists tools blocked for teammates on top of the
// collaboration whitelist. Forming and disbanding teams is the lead's
// responsibility; teammates only do the work and coordinate with each other,
// and take no part in team membership management.
var TeammateDisallowedTools = []string{"TeamCreate", "TeamDelete"}

func IsMCPTool(name string) bool {
	return strings.HasPrefix(name, "mcp__")
}

// FilterToolsForAgent
//
// Layers applied in order (TS tool-filter.ts filterToolsForAgent): 1. MCP tools (mcp__*) — exempt
// from layers 2-4 2. SUBAGENT_DISALLOWED_TOOLS — global block (recursion / main-thread only)
// 3. CUSTOM_AGENT_DISALLOWED_TOOLS — custom (non-built-in) agents only 4. ASYNC_AGENT_ALLOWED_TOOLS
// — background agents are whitelisted 5. Agent definition disallowedTools — definition-level
// blacklist 6. Agent definition tools — definition-level whitelist intersection ("*" disables
// this).
//
// isCustom: agent loaded from .yukino/agents/, not a built-in.
func FilterToolsForAgent(reg *tools.Registry, allowedTools, disallowedTools []string, isAsync bool) *tools.Registry {
	return filterToolsForAgent(reg, allowedTools, disallowedTools, isAsync, false)
}

func filterToolsForAgent(reg *tools.Registry, allowedTools, disallowedTools []string, isAsync, isCustom bool) *tools.Registry {
	disallowed := make(map[string]bool, len(disallowedTools))
	for _, name := range disallowedTools {
		disallowed[name] = true
	}

	allowed := make(map[string]bool, len(allowedTools))
	hasWhitelist := len(allowedTools) > 0 && (len(allowedTools) != 1 || allowedTools[0] != "*")
	for _, name := range allowedTools {
		allowed[name] = true
	}

	filtered := tools.NewRegistry()
	// TS tool-filter.ts:152 — the filtered registry inherits the loading mode.
	filtered.McpLoadingMode = reg.McpLoadingMode
	for _, t := range reg.ListTools() {
		name := t.Name()

		// Layer 1: MCP tools skip layers 2-4, but definition-level
		// disallowedTools/tools (layers 5-6) still apply (TS tool-filter.ts:157-163).
		if IsMCPTool(name) {
			if !disallowed[name] && (!hasWhitelist || allowed[name]) {
				filtered.Register(t)
			}
			continue
		}

		// Layer 2: global disallowed (applies to every sub-agent).
		if AllAgentDisallowedTools[name] {
			continue
		}

		// Layer 3: custom agent extra restrictions.
		if isCustom && CustomAgentDisallowedTools[name] {
			continue
		}

		// Layer 4: async agent whitelist.
		if isAsync && !AsyncAgentAllowedTools[name] {
			continue
		}

		// Layer 5: definition-level disallowed.
		if disallowed[name] {
			continue
		}

		// Layer 6: definition-level allowed (whitelist intersection).
		if hasWhitelist && !allowed[name] {
			continue
		}

		filtered.Register(t)
	}
	return filtered
}

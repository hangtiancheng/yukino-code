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

package config

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
)

// ProjectMCPFilename is the project-level MCP config file, compatible with
// the Claude Code format.
const ProjectMCPFilename = ".mcp.json"

// mcpJSONEntry mirrors the TS McpJsonEntrySchema. Pointer fields preserve the
// presence/absence distinction the TS mapping keys on: transport inference
// uses `command !== undefined`, and the http branch rejects `command !==
// undefined` even when the value is the empty string.
type mcpJSONEntry struct {
	Command *string           `json:"command"`
	Args    []string          `json:"args"`
	Env     map[string]string `json:"env"`
	Type    *string           `json:"type"`
	URL     *string           `json:"url"`
	Headers map[string]string `json:"headers"`
}

// mcpJSONFile mirrors McpJsonFileSchema: mcpServers defaults to {} and its
// raw entries are parsed independently below, so one bad server does not
// disable every valid server in the project file.
type mcpJSONFile struct {
	MCPServers json.RawMessage `json:"mcpServers"`
}

// mcpNamedEntry is one key/value pair of the mcpServers object, kept in
// document order (TS iterates Object.entries, which preserves JSON key order;
// a Go map would randomize connect order and prompt text).
type mcpNamedEntry struct {
	name string
	raw  json.RawMessage
}

func orderedMcpServers(raw json.RawMessage) ([]mcpNamedEntry, bool) {
	if len(raw) == 0 {
		return nil, true // absent key → TS default {}
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	tok, err := dec.Token()
	if err != nil || tok != json.Delim('{') {
		return nil, false // z.record rejects a non-object
	}
	var entries []mcpNamedEntry
	for dec.More() {
		keyTok, err := dec.Token()
		if err != nil {
			return nil, false
		}
		key, ok := keyTok.(string)
		if !ok {
			return nil, false
		}
		var value json.RawMessage
		if err := dec.Decode(&value); err != nil {
			return nil, false
		}
		entries = append(entries, mcpNamedEntry{name: key, raw: value})
	}
	return entries, true
}

// mcpServerFromJSONEntry maps one .mcp.json entry onto an MCPServerConfig
// (TS: mcpServerFromJsonEntry). An explicit `type` wins; otherwise stdio is
// inferred from `command` presence and http otherwise. Entries that lack the
// field their transport needs — or that carry the other transport's field —
// are rejected (returns nil).
func mcpServerFromJSONEntry(name string, entry mcpJSONEntry) *MCPServerConfig {
	transport := "http"
	if entry.Type != nil {
		// z.enum(["stdio","sse","http"]): any other spelling fails the entry
		// schema and the entry is skipped before mapping.
		switch *entry.Type {
		case "stdio", "sse", "http":
			transport = *entry.Type
		default:
			return nil
		}
	} else if entry.Command != nil {
		transport = "stdio"
	}
	if transport == "stdio" {
		if entry.Command == nil || *entry.Command == "" || entry.URL != nil {
			return nil
		}
		return &MCPServerConfig{
			Name:    name,
			Command: *entry.Command,
			Args:    entry.Args,
			Env:     entry.Env,
		}
	}
	if entry.URL == nil || *entry.URL == "" || entry.Command != nil {
		return nil
	}
	return &MCPServerConfig{
		Name:      name,
		URL:       *entry.URL,
		Transport: transport,
		Headers:   entry.Headers,
	}
}

// LoadProjectMcpServers reads project-level MCP servers from
// <workDir>/.mcp.json. A missing or malformed file yields nil so a broken
// repo-side config does not prevent startup, and an entry that cannot be
// mapped is skipped so one bad server does not hide its siblings.
func LoadProjectMcpServers(workDir string) []MCPServerConfig {
	path := filepath.Join(workDir, ProjectMCPFilename)
	if _, err := os.Stat(path); err != nil {
		// TS existsSync guard: a missing file is silent.
		return nil
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		// TS: any failure after the existence check (permission errors, a
		// race with deletion, or bad JSON) logs "invalid .mcp.json".
		log.Error("invalid .mcp.json", "path", path, "err", err)
		return nil
	}
	// McpJsonFileSchema is a (loose) object schema: JSON null, arrays and
	// scalars fail it, exactly like json.Unmarshal into the struct does for
	// non-object shapes — except literal `null`, which unmarshals into the
	// zero struct without error, so probe the top-level shape explicitly.
	var probe any
	if err := json.Unmarshal(raw, &probe); err != nil {
		log.Error("invalid .mcp.json", "path", path, "err", err)
		return nil
	}
	if _, ok := probe.(map[string]any); !ok {
		log.Error("invalid .mcp.json", "path", path, "err", "top-level value must be an object")
		return nil
	}
	var file mcpJSONFile
	if err := json.Unmarshal(raw, &file); err != nil {
		log.Error("invalid .mcp.json", "path", path, "err", err)
		return nil
	}
	entries, ok := orderedMcpServers(file.MCPServers)
	if !ok {
		log.Error("invalid .mcp.json", "path", path, "err", "mcpServers must be an object")
		return nil
	}

	var servers []MCPServerConfig
	for _, entry := range entries {
		if strings.TrimSpace(entry.name) == "" {
			log.Warn("skipping invalid .mcp.json server entry", "path", path, "name", entry.name)
			continue
		}
		var parsed mcpJSONEntry
		if err := json.Unmarshal(entry.raw, &parsed); err != nil {
			log.Warn("skipping invalid .mcp.json server entry", "path", path, "name", entry.name, "error", err)
			continue
		}
		server := mcpServerFromJSONEntry(entry.name, parsed)
		if server == nil {
			log.Warn("skipping invalid .mcp.json server entry", "path", path, "name", entry.name)
			continue
		}
		servers = append(servers, *server)
	}
	return servers
}

// WithProjectMcpServers returns a copy of cfg with the servers from
// <workDir>/.mcp.json appended. User-level (config file) entries win on a
// name collision: the project file ships with the repository and is less
// trusted than the user's own config.
func WithProjectMcpServers(cfg *AppConfig, workDir string) *AppConfig {
	projectServers := LoadProjectMcpServers(workDir)
	if len(projectServers) == 0 {
		return cfg
	}
	known := make(map[string]bool, len(cfg.MCPServers))
	for _, s := range cfg.MCPServers {
		known[s.Name] = true
	}
	merged := *cfg
	merged.MCPServers = append([]MCPServerConfig{}, cfg.MCPServers...)
	for _, s := range projectServers {
		if !known[s.Name] {
			merged.MCPServers = append(merged.MCPServers, s)
		}
	}
	return &merged
}

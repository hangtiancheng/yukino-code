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

package permissions

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"gopkg.in/yaml.v3"

	"github.com/hangtiancheng/yukino-code/yukino/logger"
	"github.com/hangtiancheng/yukino-code/yukino/tools"
	"github.com/hangtiancheng/yukino-code/yukino/utils"
)

var log = logger.CreateChildLogger("permissions")

// splitCompoundCommand splits shell compound commands (&&, ||, ;, |) into
// independent sub-commands, matching permission rules one by one to prevent
// bypass via "cmd1 && dangerous_cmd".
func splitCompoundCommand(cmd string) []string {
	parts := regexp.MustCompile(`\s*(?:&&|\|\||[;|])\s*`).Split(cmd, -1)
	var result []string
	for _, p := range parts {
		p = strings.TrimSpace(p)
		if p != "" {
			result = append(result, p)
		}
	}
	// No fallback to the raw command: TS's map/trim/filter(Boolean) can yield an
	// empty array, and the layer-3.5 loop over it then matches nothing.
	return result
}

type DecisionEffect string

const (
	Allow DecisionEffect = "allow"
	Deny  DecisionEffect = "deny"
	Ask   DecisionEffect = "ask"
)

type Decision struct {
	Effect DecisionEffect
	Reason string
}

type PermissionMode string

const (
	ModeDefault     PermissionMode = "default"
	ModeAcceptEdits PermissionMode = "acceptEdits"
	ModePlan        PermissionMode = "plan"
	ModeBypass      PermissionMode = "bypassPermissions"
)

var modeMatrix = map[PermissionMode]map[tools.ToolCategory]DecisionEffect{
	ModeDefault:     {tools.CategoryRead: Allow, tools.CategoryWrite: Ask, tools.CategoryCommand: Ask},
	ModeAcceptEdits: {tools.CategoryRead: Allow, tools.CategoryWrite: Allow, tools.CategoryCommand: Ask},
	ModeBypass:      {tools.CategoryRead: Allow, tools.CategoryWrite: Allow, tools.CategoryCommand: Allow},
	// Plan mode allows reads but asks for any mutation (TS modeDecide: plan →
	// read allow, everything else ask). Without this entry plan mode fell into
	// the unknown branch and asked for reads too.
	ModePlan: {tools.CategoryRead: Allow, tools.CategoryWrite: Ask, tools.CategoryCommand: Ask},
}

func ModeDecide(mode PermissionMode, category tools.ToolCategory) DecisionEffect {
	m, ok := modeMatrix[mode]
	if !ok {
		// TS modeDecide default branch: unknown modes behave like "default" —
		// reads are allowed, everything else asks.
		if category == tools.CategoryRead {
			return Allow
		}
		return Ask
	}
	return m[category]
}

// Layer 1: Dangerous command detection

type dangerousPattern struct {
	re     *regexp.Regexp
	reason string
}

// defaultDangerousPatterns mirrors the TS DANGEROUS_PATTERNS, which is
// deliberately empty: destructive commands are handled by the OS sandbox,
// explicit deny rules and the mode matrix (ask) rather than a hardcoded
// blocklist. The detection mechanism is kept for parity so a future list
// slots in without structural changes.
var defaultDangerousPatterns = []dangerousPattern{}

func DetectDangerous(command string) (bool, string) {
	for _, p := range defaultDangerousPatterns {
		if p.re.MatchString(command) {
			return true, p.reason
		}
	}
	return false, ""
}

// Layer 2: Path sandbox

type PathSandbox struct {
	// projectDir anchors relative paths at check time (TS: resolve(projectDir,
	// filePath)); resolving against the process cwd would make the same
	// argument mean different things as the server's cwd changes.
	projectDir   string
	allowedRoots []string
	denyWrite    []string // always read-only protected paths, higher priority than allowedRoots
}

// NewPathSandbox creates a path sandbox. Writes inside allowedRoots are
// permitted; specific paths can be write-protected via AddDenyWrite.
func NewPathSandbox(projectRoot string, extraAllowed ...string) *PathSandbox {
	root, _ := filepath.Abs(projectRoot)
	allowed := []string{root, os.TempDir()}
	for _, p := range extraAllowed {
		abs, _ := filepath.Abs(p)
		allowed = append(allowed, abs)
	}

	// TS DEFAULT_DENY_WRITE is empty: no path is protected unless a caller
	// adds it explicitly via AddDenyWrite.
	return &PathSandbox{projectDir: root, allowedRoots: allowed}
}

// resolveAbs resolves path against the sandbox's project directory (TS:
// resolve(projectDir, filePath)); absolute paths are cleaned and kept.
func (s *PathSandbox) resolveAbs(path string) string {
	if filepath.IsAbs(path) {
		return filepath.Clean(path)
	}
	return filepath.Join(s.projectDir, path)
}

// AddDenyWrite marks an extra path (or directory subtree) as write-protected
// (TS: addDenyWrite). Deny-write has the highest priority — even a path
// inside an allowed root is denied once listed here.
func (s *PathSandbox) AddDenyWrite(path string) {
	abs, _ := filepath.Abs(path)
	s.denyWrite = append(s.denyWrite, abs)
}

// CheckDenyWrite checks protected paths in isolation. These paths hold
// permission configuration and skill definitions; writes are denied under
// every permission mode, so callers must invoke it before the mode check.
// Mirrors the TS checkDenyWrite: both the lexical absolute path and the
// symlink-resolved canonical path are tested against each denied root.
func (s *PathSandbox) CheckDenyWrite(path string) (bool, string) {
	absolute := s.resolveAbs(path)
	canonical := utils.CanonicalPath(absolute)
	for _, denied := range s.denyWrite {
		if utils.IsPathWithin(denied, absolute) ||
			utils.IsPathWithin(utils.CanonicalPath(denied), canonical) {
			return false, fmt.Sprintf("Path %s is in deny-write list", path)
		}
	}
	return true, ""
}

// Check reports whether path is inside an allowed root. Mirrors the TS check:
// the path is symlink-resolved (canonicalPath) and compared against each
// canonicalized allowed root with isPathWithin, so a sibling directory sharing
// a name prefix (/ws/user10 vs root /ws/user1) is correctly rejected and a
// symlink cannot escape the sandbox. Like TS, this does NOT consult the
// deny-write list — deny-write applies to writes only and is checked by the
// caller (PermissionChecker layer 4).
func (s *PathSandbox) Check(path string) (bool, string) {
	absolute := s.resolveAbs(path)
	canonical := utils.CanonicalPath(absolute)

	for _, root := range s.allowedRoots {
		if utils.IsPathWithin(utils.CanonicalPath(root), canonical) {
			return true, ""
		}
	}
	return false, fmt.Sprintf("Path %s is outside allowed directories", path)
}

// GetDenyWrite returns the protected path list, used by sandbox Config construction.
func (s *PathSandbox) GetDenyWrite() []string {
	return s.denyWrite
}

// GetAllowedRoots returns the writable path list, used by sandbox Config construction.
func (s *PathSandbox) GetAllowedRoots() []string {
	return s.allowedRoots
}

// Layer 3: Rule engine

type RuleEffect string

const (
	RuleAllow RuleEffect = "allow"
	RuleDeny  RuleEffect = "deny"
	RuleAsk   RuleEffect = "ask"
)

type Rule struct {
	ToolName string
	Pattern  string
	Effect   RuleEffect
}

func (r Rule) Matches(toolName, content string) bool {
	// TS evaluateRules: `r.tool !== toolName && r.tool !== "*"` — a rule whose
	// tool is "*" matches every tool.
	if r.ToolName != toolName && r.ToolName != "*" {
		return false
	}
	// Simple wildcard matching: * matches any character (including /), suitable
	// for Bash commands and other non-path scenarios. filepath.Match's * does
	// not match /, causing "allow always" to fail for commands containing paths.
	return globMatch(r.Pattern, content)
}

// globMatch implements simple wildcard matching where * matches any character
// (including /).
func globMatch(pattern, content string) bool {
	// Fast path: exact comparison when no wildcards are present.
	if !strings.Contains(pattern, "*") && !strings.Contains(pattern, "?") {
		return pattern == content
	}
	// Convert pattern to regex: * → .*, ? → .
	var re strings.Builder
	re.WriteString("^")
	for _, ch := range pattern {
		switch ch {
		case '*':
			re.WriteString(".*")
		case '?':
			re.WriteString(".")
		case '.', '+', '^', '$', '{', '}', '(', ')', '|', '[', ']', '\\':
			re.WriteString("\\")
			re.WriteString(string(ch))
		default:
			re.WriteString(string(ch))
		}
	}
	re.WriteString("$")
	compiled, err := regexp.Compile(re.String())
	if err != nil {
		// TS permissions/index.ts:367-372: the catch around new RegExp logs
		// and matches nothing. After the escaping above a compile failure is
		// practically unreachable in both languages (invalid pattern bytes are
		// re-encoded as U+FFFD by the range loop); the branch is kept for
		// defensive parity.
		log.Error("permissions operation failed", "err", err)
		return false
	}
	return compiled.MatchString(content)
}

// cachedRules holds the parsed result of a single rule file. modTime and size
// together determine whether the file changed; comparing modTime alone is not
// enough, since consecutive writes within the same second may leave the
// timestamp unchanged on some filesystems.
type cachedRules struct {
	modTime time.Time
	size    int64
	rules   []Rule
}

type RuleEngine struct {
	UserPath    string
	ProjectPath string

	// The background memory agent and the main agent may share the same
	// engine, so cache reads and writes must be locked.
	mu    sync.Mutex
	cache map[string]cachedRules
}

// NewRuleEngine builds a rule engine using conventional paths: the user-level
// file lives under the home directory and the project-level file under the
// working directory (TS: RuleEngine — there is no local override file). When
// home cannot be resolved the user-level path is left empty and that layer is
// treated as having no rules.
func NewRuleEngine(workDir string) *RuleEngine {
	e := &RuleEngine{
		ProjectPath: filepath.Join(workDir, ".yukino", "permissions.yaml"),
	}
	if home, err := os.UserHomeDir(); err == nil {
		e.UserPath = filepath.Join(home, ".yukino", "permissions.yaml")
	}
	return e
}

// Evaluate merges the rules from both rule files into a single set and
// returns the strictest effect among the matched rules. Priority is
// deny > ask > allow: which layer a rule lives in, or which line of the file
// it is on, does not affect the decision, so a single deny cannot be
// overridden by an allow in another layer. Returns nil when no rule matches.
func (e *RuleEngine) Evaluate(toolName, content string) *RuleEffect {
	return EvaluateRules(e.Snapshot(), toolName, content)
}

// Snapshot returns a merged snapshot of both rule files. When a file has
// not changed, the previous parse result is reused; it is only re-read from
// disk when changed, so edits to a rule file take effect on the next
// evaluation without re-parsing on repeated evaluations. One snapshot is taken
// per tool call and shared when a compound command checks its sub-commands.
func (e *RuleEngine) Snapshot() []Rule {
	var all []Rule
	for _, path := range []string{e.UserPath, e.ProjectPath} {
		all = append(all, e.rulesFor(path)...)
	}
	return all
}

// rulesFor returns the rules of a single rule file, without reading from disk
// or parsing when the cache is hit.
func (e *RuleEngine) rulesFor(path string) []Rule {
	if path == "" {
		return nil
	}

	info, err := os.Stat(path)
	if err != nil {
		// The file does not exist or cannot be read; treat it as having no
		// rules and drop any stale cache entry.
		e.mu.Lock()
		delete(e.cache, path)
		e.mu.Unlock()
		return nil
	}

	e.mu.Lock()
	defer e.mu.Unlock()
	if c, ok := e.cache[path]; ok && c.modTime.Equal(info.ModTime()) && c.size == info.Size() {
		return c.rules
	}

	rules := loadRulesFile(path)
	if e.cache == nil {
		e.cache = make(map[string]cachedRules)
	}
	e.cache[path] = cachedRules{modTime: info.ModTime(), size: info.Size(), rules: rules}
	return rules
}

// EvaluateRules decides over the given rule set, with priority deny > ask >
// allow. Returns nil when no rule matches.
func EvaluateRules(rules []Rule, toolName, content string) *RuleEffect {
	var hit *RuleEffect
	for _, r := range rules {
		if !r.Matches(toolName, content) {
			continue
		}
		switch r.Effect {
		case RuleDeny:
			// deny is already the strictest effect and cannot be overridden;
			// return immediately.
			eff := RuleDeny
			return &eff
		case RuleAsk:
			eff := RuleAsk
			hit = &eff
		case RuleAllow:
			// allow is the weakest; record it only when no stricter effect
			// has been matched yet.
			if hit == nil {
				eff := RuleAllow
				hit = &eff
			}
		}
	}
	return hit
}

// AppendProjectRule persists a rule to the project-level YAML file in the
// `Tool(pattern)` format so "allow always" survives a restart (TS:
// appendProjectRule). Like the TS version — whose mkdirSync/writeFileSync
// throws surface to the allowAlways caller (the agent loop turns them into
// `Permission request failed: ...`) — the filesystem errors are returned
// instead of being swallowed.
func (e *RuleEngine) AppendProjectRule(r Rule) error {
	if e.ProjectPath == "" {
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(e.ProjectPath), 0o755); err != nil {
		return fmt.Errorf("mkdir %s: %w", filepath.Dir(e.ProjectPath), err)
	}
	rules := loadRulesFile(e.ProjectPath)
	// Deduplicate: skip if an identical {tool, pattern, effect} rule already
	// exists. Without this, every "allow always" click on the same command
	// appends a duplicate entry (the rule engine matches but allowAlways is
	// still called in some flows, e.g. cross-session content variants).
	for _, existing := range rules {
		if existing.ToolName == r.ToolName && existing.Pattern == r.Pattern && existing.Effect == r.Effect {
			return nil
		}
	}
	rules = append(rules, r)
	// A struct slice keeps the TS yaml.dump key order (rule before effect);
	// map entries would be marshaled alphabetically.
	type entry struct {
		Rule   string `yaml:"rule"`
		Effect string `yaml:"effect"`
	}
	entries := make([]entry, 0, len(rules))
	for _, rule := range rules {
		entries = append(entries, entry{
			Rule:   fmt.Sprintf("%s(%s)", rule.ToolName, rule.Pattern),
			Effect: string(rule.Effect),
		})
	}
	data, err := yaml.Marshal(entries)
	if err != nil {
		return fmt.Errorf("marshal rules: %w", err)
	}
	if err := os.WriteFile(e.ProjectPath, data, 0o644); err != nil {
		return fmt.Errorf("write %s: %w", e.ProjectPath, err)
	}
	return nil
}

// yamlRuleEntry is one schema-validated entry of a rules file.
type yamlRuleEntry struct {
	rule   string
	effect string
}

// loadRulesFile loads a rules file: a top-level YAML list of
// `{ rule: "Tool(pattern)", effect: "allow"|"deny"|"ask" }` (TS
// permissions/index.ts:379-419). A missing file yields no rules silently; any
// other read failure, YAML error or schema violation logs
// "permissions operation failed" and rejects the WHOLE file like the TS zod
// parse — a null (or otherwise non-object) entry invalidates its siblings
// instead of being dropped in isolation.
func loadRulesFile(path string) []Rule {
	if path == "" {
		return nil
	}
	data, err := os.ReadFile(path)
	if err != nil {
		// TS: only non-ENOENT read failures are logged.
		if !os.IsNotExist(err) {
			log.Error("permissions operation failed", "err", err)
		}
		return nil
	}
	var doc any
	if err := yaml.Unmarshal(data, &doc); err != nil {
		log.Error("permissions operation failed", "err", err)
		return nil
	}
	entries, err := rulesYamlEntries(doc)
	if err != nil {
		log.Error("permissions operation failed", "err", err)
		return nil
	}
	var rules []Rule
	for _, e := range entries {
		if e.effect != "allow" && e.effect != "deny" && e.effect != "ask" {
			continue
		}
		r, err := parseRule(e.rule, RuleEffect(e.effect))
		if err != nil {
			continue
		}
		rules = append(rules, r)
	}
	return rules
}

// rulesYamlEntries validates the decoded document the way the TS zod
// z.array(YamlEntrySchema) parse does: the top level must be a list whose
// entries are objects with optional string rule/effect fields — null is
// rejected (z.string().optional() accepts undefined but not null). An empty or
// comment-only file decodes to nil and fails the list check exactly like the
// TS undefined input.
func rulesYamlEntries(doc any) ([]yamlRuleEntry, error) {
	list, ok := doc.([]any)
	if !ok {
		return nil, fmt.Errorf("permissions rules must be a YAML list, got %T", doc)
	}
	entries := make([]yamlRuleEntry, 0, len(list))
	for i, item := range list {
		fields, ok := yamlStringKeyedMap(item)
		if !ok {
			return nil, fmt.Errorf("permissions rule entry %d must be a mapping, got %T", i, item)
		}
		var e yamlRuleEntry
		if v, present := fields["rule"]; present {
			s, ok := v.(string)
			if !ok {
				return nil, fmt.Errorf("permissions rule entry %d rule must be a string, got %T", i, v)
			}
			e.rule = s
		}
		if v, present := fields["effect"]; present {
			s, ok := v.(string)
			if !ok {
				return nil, fmt.Errorf("permissions rule entry %d effect must be a string, got %T", i, v)
			}
			e.effect = s
		}
		entries = append(entries, e)
	}
	return entries, nil
}

// yamlStringKeyedMap coerces a decoded YAML node to a string-keyed mapping
// (js-yaml load stringifies mapping keys, so a non-string key still yields a
// valid object for the zod schema).
func yamlStringKeyedMap(v any) (map[string]any, bool) {
	switch m := v.(type) {
	case map[string]any:
		return m, true
	case map[any]any:
		out := make(map[string]any, len(m))
		for k, val := range m {
			out[fmt.Sprint(k)] = val
		}
		return out, true
	}
	return nil, false
}

var ruleRE = regexp.MustCompile(`^(\w+)\((.+)\)$`)

func parseRule(raw string, effect RuleEffect) (Rule, error) {
	m := ruleRE.FindStringSubmatch(strings.TrimSpace(raw))
	if m == nil {
		return Rule{}, fmt.Errorf("invalid rule syntax: %s", raw)
	}
	return Rule{ToolName: m[1], Pattern: m[2], Effect: effect}, nil
}

// Content extraction for rule matching

var contentFields = map[string]string{
	"Bash": "command", "PowerShell": "command", "ComputerUse": "action",
	"ReadFile": "file_path", "WriteFile": "file_path",
	"EditFile": "file_path", "Glob": "pattern", "Grep": "pattern",
	"InstallSkill": "source",
}

func ExtractContent(toolName string, args map[string]any) string {
	// McpCall's match target is not a single argument but "which MCP tool to
	// invoke", composed from the server + tool arguments as server__tool.
	// This allows rules like McpCall(linear__*) to allow/deny by server or
	// by tool.
	if toolName == tools.McpCallToolName {
		server, _ := args["server"].(string)
		tool, _ := args["tool"].(string)
		return tools.McpCallPermissionContent(server, tool)
	}
	field, ok := contentFields[toolName]
	if !ok {
		return ""
	}
	if v, ok := args[field].(string); ok {
		return v
	}
	// ComputerUse also accepts the OpenAI batched form (actions[] instead of
	// action); summarize the action types so rule matching and prompts still see
	// what the call does (TS extractContent).
	if toolName == "ComputerUse" {
		if actions, ok := args["actions"].([]any); ok {
			var types []string
			for _, item := range actions {
				if rec, ok := item.(map[string]any); ok {
					if t, ok := rec["type"].(string); ok && t != "" {
						types = append(types, t)
					}
				}
			}
			return strings.Join(types, ",")
		}
	}
	return ""
}

// DescribeToolAction generates a human-readable action description for HITL
// confirmation. It extracts from standard content fields (command, file_path,
// etc.) first; falls back to a concatenated argument summary.
func DescribeToolAction(toolName string, args map[string]any) string {
	content := ExtractContent(toolName, args)
	if content != "" {
		return content
	}
	// No standard field available; build a `key: value` summary like TS. Go maps
	// do not preserve the JSON insertion order TS iterates, so keys are sorted
	// for a deterministic rendering.
	if len(args) == 0 {
		return ""
	}
	keys := make([]string, 0, len(args))
	for k := range args {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	parts := make([]string, 0, len(keys))
	for _, k := range keys {
		s := jsStringOf(args[k])
		if utils.UTF16Len(s) > 80 {
			s = utils.TruncateUTF16(s, 80) + "..."
		}
		parts = append(parts, fmt.Sprintf("%s: %s", k, s))
	}
	return strings.Join(parts, ", ")
}

// jsStringOf renders a tool-argument value the way JS String(value) does in
// the describeToolAction fallback (TS permissions/index.ts:783): strings pass
// through, nil renders "null" (JSON-sourced args carry null, never undefined),
// booleans as "true"/"false", numbers with JS String(number) formatting,
// arrays as their elements joined with ",", and any other object as
// "[object Object]" — where Go's fmt.Sprint would emit map[k:v]/[a b].
func jsStringOf(v any) string {
	switch t := v.(type) {
	case nil:
		return "null"
	case string:
		return t
	case bool:
		if t {
			return "true"
		}
		return "false"
	case float64:
		return jsNumberOf(t)
	case float32:
		return jsNumberOf(float64(t))
	case int:
		return strconv.Itoa(t)
	case int64:
		return strconv.FormatInt(t, 10)
	case json.Number:
		if f, err := t.Float64(); err == nil {
			return jsNumberOf(f)
		}
		return t.String()
	case []any:
		parts := make([]string, 0, len(t))
		for _, e := range t {
			parts = append(parts, jsArrayElement(e))
		}
		return strings.Join(parts, ",")
	case map[string]any:
		return "[object Object]"
	case map[any]any:
		return "[object Object]"
	}
	return fmt.Sprint(v)
}

// jsArrayElement renders one array element for the join: Array.prototype.join
// renders null/undefined as "" (unlike top-level String(null) = "null"), and
// nested arrays flatten through the same join ([["a"],"b"] -> "a,b").
func jsArrayElement(v any) string {
	if v == nil {
		return ""
	}
	return jsStringOf(v)
}

// jsNumberOf renders a float64 like JS String(number) (shared helper).
func jsNumberOf(f float64) string { return utils.JSNumberString(f) }

// Layer 4+5: Permission Checker (orchestrates all layers)

// MemoryScope restricts a checker to the background memory agent's semantics
// (TS: MemoryPermissionChecker). When set on a Checker, Check delegates to the
// scoped logic instead of the normal layer stack: command-category tools are
// always denied, writes are allowed only to .md files inside the memory roots,
// and reads are allowed inside the memory roots (plus the project directory
// when AllowProjectReads is set).
type MemoryScope struct {
	// WorkDir the memory agent resolves relative paths against.
	WorkDir string
	// MemoryRoots are the directories the agent may write .md files into
	// (project .yukino/memory and the user-level memory dir).
	MemoryRoots []string
	// AllowProjectReads additionally permits reads anywhere inside WorkDir
	// (TS: consolidation passes true, extraction passes false).
	AllowProjectReads bool
}

type Checker struct {
	Sandbox      *PathSandbox
	RuleEngine   *RuleEngine
	Mode         PermissionMode
	PlanFilePath string
	// SandboxEnabled indicates whether the OS-level sandbox is active.
	// When enabled, Bash commands execute inside the sandbox; with autoAllow
	// confirmation can be skipped.
	SandboxEnabled bool
	// SandboxAutoAllow, when true together with SandboxEnabled, lets non-dangerous
	// Bash commands skip human confirmation (TS: sandboxAutoAllow). Only Bash is
	// covered — other command tools (e.g. PowerShell) never inherit this.
	SandboxAutoAllow bool
	// MemoryScope, when non-nil, switches Check to the scoped background-memory
	// semantics (TS: MemoryPermissionChecker overrides check).
	MemoryScope *MemoryScope
}

// NewMemoryChecker builds a checker for the background memory agent (TS:
// MemoryPermissionChecker). memoryWorkDir is the project root; the memory roots
// are the project .yukino/memory plus userMemoryDir. An empty userMemoryDir
// means "no user-level root" rather than falling back to ~/.yukino/memory: the
// multi-user host deliberately leaves it empty so one chat user's memories
// cannot be written (or read) through an absolute path in another user's
// session. Library callers that want the TS single-user behaviour pass
// GetUserAutoMemPath() explicitly.
func NewMemoryChecker(memoryWorkDir, userMemoryDir string, allowProjectReads bool) *Checker {
	roots := []string{filepath.Join(memoryWorkDir, ".yukino", "memory")}
	if userMemoryDir != "" {
		roots = append(roots, userMemoryDir)
	}
	return &Checker{
		Mode: ModeDefault,
		MemoryScope: &MemoryScope{
			WorkDir:           memoryWorkDir,
			MemoryRoots:       roots,
			AllowProjectReads: allowProjectReads,
		},
	}
}

// checkMemoryScoped implements the TS MemoryPermissionChecker.check override.
func (c *Checker) checkMemoryScoped(toolName string, cat tools.ToolCategory, args map[string]any) Decision {
	scope := c.MemoryScope

	// requested = args.file_path ?? args.path ?? workDir (TS nullish
	// coalescing): null/absent falls through, an empty string or a non-string
	// value does not.
	requested := scope.WorkDir
	nonString := false
	if v, present := args["file_path"]; present && v != nil {
		if s, ok := v.(string); ok {
			requested = s
		} else {
			nonString = true
		}
	} else if v, present := args["path"]; present && v != nil {
		if s, ok := v.(string); ok {
			requested = s
		} else {
			nonString = true
		}
	}

	// Command-category tools are never allowed for background memory tasks;
	// a non-string requested path is rejected the same way (TS).
	if cat == tools.CategoryCommand || nonString {
		return Decision{Effect: Deny, Reason: "Background memory tasks only support scoped file operations"}
	}

	path := utils.CanonicalPath(ResolvePath(scope.WorkDir, requested))
	insideMemory := false
	for _, root := range scope.MemoryRoots {
		if utils.IsPathWithin(utils.CanonicalPath(root), path) {
			insideMemory = true
			break
		}
	}

	if cat == tools.CategoryWrite {
		if insideMemory && filepath.Ext(path) == ".md" {
			return Decision{Effect: Allow, Reason: "Memory file update"}
		}
		return Decision{Effect: Deny, Reason: "Background memory writes must stay in the memory directories and use .md files"}
	}

	// read category
	if insideMemory || (scope.AllowProjectReads && utils.IsPathWithin(utils.CanonicalPath(scope.WorkDir), path)) {
		return Decision{Effect: Allow, Reason: "Memory task read"}
	}
	return Decision{Effect: Deny, Reason: "Read outside the memory task's scope"}
}

// ResolvePath resolves a possibly-relative path against workDir, mirroring
// Node's path.resolve. It is duplicated here (rather than importing tools) to
// avoid a dependency cycle: tools imports permissions for category constants.
func ResolvePath(workDir, requestedPath string) string {
	if requestedPath == "" {
		return workDir
	}
	if filepath.IsAbs(requestedPath) {
		return filepath.Clean(requestedPath)
	}
	if workDir == "" {
		return requestedPath
	}
	return filepath.Join(workDir, requestedPath)
}

func NewChecker(sandbox *PathSandbox, ruleEngine *RuleEngine, mode PermissionMode) *Checker {
	return &Checker{
		Sandbox:    sandbox,
		RuleEngine: ruleEngine,
		Mode:       mode,
	}
}

// Check evaluates a tool call the caller holds as a Tool instance. TS
// check() takes (toolName, category, args) — see CheckNamed; this is a
// convenience wrapper for the common case.
func (c *Checker) Check(tool tools.Tool, args map[string]any) Decision {
	return c.CheckNamed(tool.Name(), tool.Category(), args)
}

// CheckNamed evaluates a permission decision for a tool call given its name
// and category (TS PermissionChecker.check(toolName, category, args)). The
// agent uses it directly so an unknown tool name can still be checked with
// the TS fallback category "command".
func (c *Checker) CheckNamed(toolName string, cat tools.ToolCategory, args map[string]any) Decision {
	// Background memory agents run under the scoped checker (TS:
	// MemoryPermissionChecker overrides check entirely).
	if c.MemoryScope != nil {
		return c.checkMemoryScoped(toolName, cat, args)
	}

	content := ExtractContent(toolName, args)
	// The rule snapshot is taken lazily once: safe commands, dangerous
	// commands, and the like return in earlier layers and never need to touch
	// the rule files; compound commands share the same snapshot when checking
	// sub-commands, avoiding repeated disk reads.
	snapshot := sync.OnceValue(c.RuleEngine.Snapshot)

	// Explicit rules are evaluated first (TS): a deny or ask rule short-circuits
	// before the safe-command auto-allow, so e.g. `Bash(ls *) deny` actually
	// blocks `ls` instead of being shadowed by the safe-command layer. Allow
	// rules do not short-circuit here; they are honored in the later rule layer.
	if r := EvaluateRules(snapshot(), toolName, content); r != nil {
		switch *r {
		case RuleDeny:
			return Decision{Effect: Deny, Reason: "Permission rule: deny"}
		case RuleAsk:
			return Decision{Effect: Ask, Reason: "Permission rule: ask"}
		}
	}

	// Layer 0: plan-mode plan-file write exception. Both WriteFile and EditFile
	// targeting the plan file are allowed so the model can create and update
	// its plan, unless the path is write-protected. TS reads only `file_path`
	// here (no `path` fallback) and requires an exact canonical match against
	// the resolved plan file path — no basename or suffix heuristics.
	if c.Mode == ModePlan && (toolName == "WriteFile" || toolName == "EditFile") {
		p, _ := args["file_path"].(string)
		if p != "" && c.PlanFilePath != "" &&
			utils.CanonicalPath(c.Sandbox.resolveAbs(p)) == utils.CanonicalPath(c.Sandbox.resolveAbs(c.PlanFilePath)) {
			if ok, _ := c.Sandbox.CheckDenyWrite(p); ok {
				return Decision{Effect: Allow, Reason: "Plan file write allowed in plan mode"}
			}
		}
	}

	// Layer 2: safe read-only commands (auto-allow)
	if cat == tools.CategoryCommand && tools.IsSafeCommand(content) {
		return Decision{Effect: Allow, Reason: "Safe read-only command"}
	}

	// Layer 3: dangerous command block — reason records the specific pattern.
	// The blacklist is a hard line of defense: it must always be checked,
	// regardless of whether the sandbox is enabled.
	if cat == tools.CategoryCommand {
		hit, reason := DetectDangerous(content)
		if hit {
			return Decision{Effect: Deny, Reason: fmt.Sprintf("Dangerous command blocked: %s", reason)}
		}
	}

	// Layer 3.5: sandbox auto-allow — OS sandbox already isolates writes, so
	// non-dangerous Bash commands can skip human confirmation. Only Bash is
	// wrapped by the configured OS sandbox; other command tools (e.g. PowerShell)
	// never inherit this auto-allow. Compound commands are split and checked
	// individually; any sub-command triggering deny causes overall deny, any
	// triggering ask causes a prompt.
	if c.SandboxEnabled && c.SandboxAutoAllow && toolName == "Bash" {
		subcommands := splitCompoundCommand(content)
		var hasAsk bool
		for _, sub := range subcommands {
			r := EvaluateRules(snapshot(), toolName, sub)
			if r != nil && *r == RuleDeny {
				return Decision{Effect: Deny, Reason: "Permission rule: deny"}
			}
			if r != nil && *r == RuleAsk {
				hasAsk = true
			}
		}
		if hasAsk {
			return Decision{Effect: Ask, Reason: "Permission rule: ask (sandbox does not override)"}
		}
		return Decision{Effect: Allow, Reason: "Sandbox auto-allow: OS sandbox active"}
	}

	// Layer 4: path sandbox (file tools only). The path is taken from
	// file_path or path (TS), not the generic content field, so tools like
	// Grep(path=...) are sandbox-checked on the right argument.
	filePath := fileOrPathArg(args)
	if (cat == tools.CategoryRead || cat == tools.CategoryWrite) && filePath != "" {
		// Protected paths are decided first: writes to permission config or
		// skill definitions are always denied, even in bypass mode.
		if cat == tools.CategoryWrite {
			if ok, reason := c.Sandbox.CheckDenyWrite(filePath); !ok {
				return Decision{Effect: Deny, Reason: reason}
			}
		}
		if ok, reason := c.Sandbox.Check(filePath); !ok && c.Mode != ModeBypass {
			// An explicit rule (e.g. `ReadFile(/foo/*)` allow) overrides the
			// sandbox ask; otherwise rules for outside paths could never apply.
			if r := EvaluateRules(snapshot(), toolName, content); r != nil {
				switch *r {
				case RuleAllow:
					return Decision{Effect: Allow, Reason: "Permission rule: allow"}
				case RuleAsk:
					return Decision{Effect: Ask, Reason: "Permission rule: ask"}
				default:
					return Decision{Effect: Deny, Reason: "Permission rule: deny"}
				}
			}
			// TS returns the sandbox decision's reason verbatim.
			return Decision{Effect: Ask, Reason: reason}
		}
	}

	// Layer 5: rule engine — per-tool content + glob match (allow/deny/ask).
	ruleResult := EvaluateRules(snapshot(), toolName, content)
	if ruleResult != nil {
		switch *ruleResult {
		case RuleAllow:
			return Decision{Effect: Allow, Reason: "Permission rule: allow"}
		case RuleAsk:
			return Decision{Effect: Ask, Reason: "Permission rule: ask"}
		default:
			return Decision{Effect: Deny, Reason: "Permission rule: deny"}
		}
	}

	// Layer 6: mode matrix.
	return Decision{Effect: ModeDecide(c.Mode, cat), Reason: fmt.Sprintf("Mode: %s", c.Mode)}
}

// fileOrPathArg mirrors the TS layer-4 extraction
// `strArg(args, "file_path", strArg(args, "path", ""))`: strArg returns any
// string value, so a present-but-empty file_path does not fall through to
// path — and an empty result skips the whole path-sandbox layer.
func fileOrPathArg(args map[string]any) string {
	if v, ok := args["file_path"].(string); ok {
		return v
	}
	if v, ok := args["path"].(string); ok {
		return v
	}
	return ""
}

// IsSafeCommand reports whether a command is a read-only safe command.
//
// The implementation lives in the tools package because the concurrency
// scheduler needs the same predicate (read-only commands may run alongside
// read-only tools), and tools must not depend on permissions. This is a
// thin forwarding wrapper so existing call sites in the rules layer are unchanged.
func IsSafeCommand(command string) bool { return tools.IsSafeCommand(command) }

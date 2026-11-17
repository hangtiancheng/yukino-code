package permissions

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"gopkg.in/yaml.v3"

	"github.com/yukino-js/yukino/yukino/internal/storage"
	"github.com/yukino-js/yukino/yukino/internal/tools"
	"github.com/yukino-js/yukino/yukino/internal/utils"
	"github.com/yukino-js/yukino/yukino/internal/worktree"
)

type DecisionEffect string

const (
	Allow DecisionEffect = "allow"
	Deny  DecisionEffect = "deny"
	Ask   DecisionEffect = "ask"
)

type Decision struct {
	Effect DecisionEffect
	Reason string
	// RememberPatterns are the rule patterns offered for "allow always".
	RememberPatterns []string
}

type PermissionMode string

const (
	ModeDefault     PermissionMode = "default"
	ModeAcceptEdits PermissionMode = "acceptEdits"
	ModePlan        PermissionMode = "plan"
	ModeBypass      PermissionMode = "bypassPermissions"
)

func modeDecide(mode PermissionMode, category tools.ToolCategory) DecisionEffect {
	switch mode {
	case ModeBypass:
		return Allow
	case ModePlan:
		if category == tools.CategoryRead {
			return Allow
		}
		return Deny
	case ModeAcceptEdits:
		if category == tools.CategoryCommand {
			return Ask
		}
		return Allow
	default:
		if category == tools.CategoryRead {
			return Allow
		}
		return Ask
	}
}

func escapeRuleLiteral(content string) string {
	return regexp.MustCompile(`([\\*?])`).ReplaceAllString(content, `\$1`)
}

// normalizePathPattern resolves a rule pattern against cwd. Literal patterns
// become canonical absolute paths; wildcard patterns resolve their fixed
// prefix and keep the wildcard suffix. Traversal after a wildcard is rejected.
func normalizePathPattern(cwd, pattern string) (string, error) {
	if filepath.Separator == '\\' {
		pattern = strings.ReplaceAll(pattern, "\\", "/")
	}
	if pattern == "*" {
		return pattern, nil
	}
	wildcard := -1
	for i := 0; i < len(pattern); i++ {
		if pattern[i] == '\\' {
			i++
		} else if pattern[i] == '*' || pattern[i] == '?' {
			wildcard = i
			break
		}
	}
	literal := func(text string) string {
		return regexp.MustCompile(`\\(.)`).ReplaceAllString(text, "$1")
	}
	if wildcard < 0 {
		canonical, err := utils.CanonicalPath(utils.ResolveToolPath(cwd, literal(pattern)), 0)
		if err != nil {
			return "", err
		}
		return escapeRuleLiteral(filepath.ToSlash(canonical)), nil
	}
	slash := strings.LastIndex(pattern[:wildcard], "/")
	fixed := "."
	suffix := pattern
	if slash >= 0 {
		fixed = pattern[:slash+1]
		suffix = pattern[slash+1:]
	}
	if slicesContains(strings.Split(suffix, "/"), "..") {
		return "", fmt.Errorf("%s", PathPatternTraversalError)
	}
	canonical, err := utils.CanonicalPath(utils.ResolveToolPath(cwd, literal(fixed)), 0)
	if err != nil {
		return "", err
	}
	prefix := strings.TrimSuffix(filepath.ToSlash(canonical), "/")
	return escapeRuleLiteral(prefix) + "/" + suffix, nil
}

func slicesContains(list []string, value string) bool {
	for _, item := range list {
		if item == value {
			return true
		}
	}
	return false
}

// ExtractContent returns the per-tool match target used for safe/dangerous
// checks and rule matching.
func ExtractContent(toolName string, args map[string]any) string {
	// The match target for McpCall is not a specific parameter but "which MCP
	// tool to call", derived from the server + tool parameters as server__tool.
	// This lets a rule like McpCall(linear__*) allow/deny per server or per tool.
	if toolName == tools.McpCallToolName {
		server, _ := args["server"].(string)
		tool, _ := args["tool"].(string)
		return tools.McpCallPermissionContent(server, tool)
	}
	field, ok := ContentFields[toolName]
	if !ok {
		return ""
	}
	if v, ok := args[field].(string); ok {
		return v
	}
	// ComputerUse also accepts the batched form (actions[] instead of
	// action); summarize the action types so rule matching and prompts still
	// see what the call does.
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

// PathSandbox restricts writes to the project directory plus os.TempDir();
// extra roots can be added explicitly.
type PathSandbox struct {
	mu           sync.RWMutex
	projectDir   string
	allowedRoots []string
}

func NewPathSandbox(projectDir string, includeTempOption ...bool) *PathSandbox {
	abs, err := filepath.Abs(projectDir)
	if err != nil {
		abs = projectDir
	}
	roots := []string{abs}
	includeTemp := len(includeTempOption) == 0 || includeTempOption[0]
	if includeTemp {
		roots = append(roots, os.TempDir())
	}
	return &PathSandbox{projectDir: abs, allowedRoots: roots}
}

func (s *PathSandbox) ProjectDir() string { s.mu.RLock(); defer s.mu.RUnlock(); return s.projectDir }

func (s *PathSandbox) AddRoot(root string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.allowedRoots = append(s.allowedRoots, utils.ResolveToolPath(s.projectDir, root))
}

func (s *PathSandbox) GetAllowedRoots() []string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return append([]string(nil), s.allowedRoots...)
}

// Check returns nil when the path is inside an allowed root.
func (s *PathSandbox) Check(filePath string) *Decision {
	s.mu.RLock()
	defer s.mu.RUnlock()
	deny := &Decision{Effect: Deny, Reason: fmt.Sprintf("Path %s is outside allowed directories", filePath)}
	absolute, err := utils.CanonicalPath(utils.ResolveToolPath(s.projectDir, filePath), 0)
	if err != nil {
		return deny
	}
	for _, root := range s.allowedRoots {
		canonical, err := utils.CanonicalPath(root, 0)
		if err != nil {
			continue
		}
		if utils.IsPathWithin(canonical, absolute) {
			return nil
		}
	}
	return deny
}

// globMatch matches where `*` matches any run of characters (including /) and
// `?` matches any single character — suited to matching shell commands rather
// than paths, so it deliberately deviates from filepath.Match semantics.
func globMatch(pattern, content string, insensitive bool) bool {
	var re strings.Builder
	re.WriteString("^")
	for i := 0; i < len(pattern); i++ {
		char := pattern[i]
		if char == '\\' && i+1 < len(pattern) {
			i++
			re.WriteString(regexp.QuoteMeta(string(pattern[i])))
		} else if char == '*' {
			re.WriteString(`[\s\S]*`)
		} else if char == '?' {
			re.WriteString(`[\s\S]`)
		} else {
			re.WriteString(regexp.QuoteMeta(string(char)))
		}
	}
	re.WriteString("$")
	expr := re.String()
	if insensitive {
		expr = "(?i)" + expr
	}
	matched, err := regexp.MatchString(expr, content)
	if err != nil {
		return false
	}
	return matched
}

type RuleEffect = DecisionEffect

type Rule struct {
	Tool    string
	Pattern string
	Effect  RuleEffect
}

// loadRulesFile reads a rules file: a top-level YAML list of
// `{ rule: "Tool(pattern)", effect: "allow"|"deny"|"ask" }`.
func loadRulesFile(path string) ([]Rule, error) {
	data, err := storage.ReadPrivateFileSync(path)
	if err != nil {
		if os.IsNotExist(err) {
			if _, linkErr := os.Lstat(path); os.IsNotExist(linkErr) {
				return nil, nil
			}
		}
		return nil, err
	}
	var entries []map[string]any
	if err := yaml.Unmarshal(data, &entries); err != nil {
		return nil, fmt.Errorf("%s: %w", RulesParseError, err)
	}
	var rules []Rule
	for _, entry := range entries {
		if entry == nil {
			return nil, errors.New(RulesParseError)
		}
		ruleValue, hasRule := entry["rule"]
		effectValue, hasEffect := entry["effect"]
		rule, ruleOK := ruleValue.(string)
		effect, effectOK := effectValue.(string)
		if hasRule && !ruleOK || hasEffect && !effectOK {
			return nil, errors.New(RulesParseError)
		}
		if effect != "allow" && effect != "deny" && effect != "ask" {
			continue
		}
		m := RuleRE.FindStringSubmatch(strings.TrimSpace(rule))
		if m == nil {
			continue
		}
		rules = append(rules, Rule{m[1], m[2], RuleEffect(effect)})
	}
	return rules, nil
}

// EvaluateRules adjudicates over the given rule set with priority
// deny > ask > allow. It returns nil when no rule matches.
func EvaluateRules(rules []Rule, toolName, content string, insensitive bool) *RuleEffect {
	var hit *RuleEffect
	for _, r := range rules {
		if r.Tool != toolName && r.Tool != "*" {
			continue
		}
		if !globMatch(r.Pattern, content, insensitive) {
			continue
		}
		// deny is the strictest effect and cannot be overridden; return
		// immediately.
		if r.Effect == Deny {
			eff := Deny
			return &eff
		}
		if r.Effect == Ask {
			eff := Ask
			hit = &eff
		} else if hit == nil {
			// allow is the weakest effect; record only when no stricter
			// effect has matched yet.
			eff := Allow
			hit = &eff
		}
	}
	return hit
}

type cachedRules struct {
	modTime time.Time
	size    int64
	rules   []Rule
}

// RuleEngine merges the user-level and project-level rules files.
type RuleEngine struct {
	userPath    string
	projectPath string

	mu    sync.Mutex
	cache map[string]cachedRules
}

func NewRuleEngine(cwd string) *RuleEngine {
	e := &RuleEngine{
		userPath: storage.YukinoPath(PermissionsRulesFilename),
		cache:    map[string]cachedRules{},
	}
	if p, err := storage.ProjectPath(cwd, PermissionsRulesFilename); err == nil {
		e.projectPath = p
	}
	return e
}

func (e *RuleEngine) ProjectPath() string { return e.projectPath }

// rulesFor reads a single rules file; skips re-reading and parsing on cache
// hit. mtime + size together serve as the change indicator — either alone can
// miss a rewrite.
func (e *RuleEngine) rulesFor(path string) ([]Rule, error) {
	if path == "" {
		return nil, nil
	}
	info, err := os.Stat(path)
	if err != nil {
		e.mu.Lock()
		delete(e.cache, path)
		e.mu.Unlock()
		if os.IsNotExist(err) {
			if _, linkErr := os.Lstat(path); os.IsNotExist(linkErr) {
				return nil, nil
			}
		}
		return nil, err
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	if c, ok := e.cache[path]; ok && c.modTime.Equal(info.ModTime()) && c.size == info.Size() {
		return c.rules, nil
	}
	rules, err := loadRulesFile(path)
	if err != nil {
		return nil, err
	}
	if e.cache == nil {
		e.cache = map[string]cachedRules{}
	}
	e.cache[path] = cachedRules{modTime: info.ModTime(), size: info.Size(), rules: rules}
	return rules, nil
}

// Snapshot returns the merged snapshot of both rules files.
func (e *RuleEngine) Snapshot() ([]Rule, error) {
	var all []Rule
	for _, path := range []string{e.userPath, e.projectPath} {
		rules, err := e.rulesFor(path)
		if err != nil {
			return nil, err
		}
		all = append(all, rules...)
	}
	return all, nil
}

// AppendProjectRule persists a rule to the project-level YAML file in the
// `Tool(pattern)` format so "allow always" survives a restart.
func (e *RuleEngine) AppendProjectRule(rule Rule) error {
	if e.projectPath == "" {
		return errors.New("Project permission rules path is unavailable")
	}
	if err := storage.MkdirPrivateSync(filepath.Dir(e.projectPath)); err != nil {
		return err
	}
	return storage.WithFileSyncLock(e.projectPath, func() error {
		rules, err := loadRulesFile(e.projectPath)
		if err != nil {
			return err
		}
		for _, r := range rules {
			if r.Tool == rule.Tool && r.Pattern == rule.Pattern && r.Effect == rule.Effect {
				return nil
			}
		}
		rules = append(rules, rule)
		type ruleEntry struct {
			Rule   string `yaml:"rule"`
			Effect string `yaml:"effect"`
		}
		entries := make([]ruleEntry, 0, len(rules))
		for _, r := range rules {
			entries = append(entries, ruleEntry{Rule: fmt.Sprintf("%s(%s)", r.Tool, r.Pattern), Effect: string(r.Effect)})
		}
		data, err := yaml.Marshal(entries)
		if err != nil {
			return err
		}
		tempPath := fmt.Sprintf("%s.%d.tmp", e.projectPath, os.Getpid())
		defer os.Remove(tempPath)
		if err := storage.WritePrivateFileSync(tempPath, data, os.O_WRONLY|os.O_CREATE|os.O_TRUNC); err != nil {
			return err
		}
		if err := os.Rename(tempPath, e.projectPath); err != nil {
			return err
		}
		e.mu.Lock()
		delete(e.cache, e.projectPath)
		e.mu.Unlock()
		return nil
	})
}

// Checker decides allow/deny/ask for tool calls under a permission mode.
type Checker struct {
	Policy               func(tools.Tool, map[string]any) Decision
	SearchReadPolicy     func(string) bool
	SearchTraversePolicy func(string) bool
	Sandbox              *PathSandbox
	RuleEngine           *RuleEngine
	modeState            *permissionModeState
	planModeState        *planModeState
	parent               *Checker
	projectCwd           string
	worktreeMu           sync.RWMutex
	Worktrees            *worktree.OwnedWorktrees
	extraRoots           []string
	isolatedRoot         string
	activeWorktree       *worktree.WorktreeSession
	restoredCwd          string
	enteredWorktrees     map[string]bool
	// PlanFilePath is the only file writable while in plan mode.
	planFilePath string
	planPathMu   sync.RWMutex
	// Teammate checkers auto-allow internal team messaging and the shared
	// task board.
	Teammate bool
	// ReadOnly checkers behave like plan mode regardless of Mode.
	ReadOnly bool
	// RequiresLeaderPlanApproval keeps teammate plan mode until the leader
	// approves.
	RequiresLeaderPlanApproval bool
	// SandboxEnabled: when true, Bash commands run through OS sandbox
	// isolation. SandboxAutoAllow additionally skips human confirmation for
	// sandboxed Bash.
	SandboxEnabled   bool
	SandboxAutoAllow bool
}

func NewChecker(sandbox *PathSandbox, ruleEngine *RuleEngine, mode PermissionMode) *Checker {
	cwd := ""
	if sandbox != nil {
		cwd = sandbox.ProjectDir()
	}
	return &Checker{
		Sandbox:          sandbox,
		RuleEngine:       ruleEngine,
		modeState:        &permissionModeState{value: mode, events: &modeEvents{listeners: make(map[uint64]func())}},
		planModeState:    &planModeState{},
		projectCwd:       cwd,
		Worktrees:        &worktree.OwnedWorktrees{},
		enteredWorktrees: make(map[string]bool),
	}
}

// Check decides a tool call; path resolution failures deny.
func (c *Checker) Check(tool tools.Tool, args map[string]any) (decision Decision) {
	return c.CheckNamed(tool.Name(), tool.Category(), args)
}

// CheckNamed decides a call by tool name and category without a Tool value.
// It preserves the Policy override so scoped checkers see the same call.
func (c *Checker) CheckNamed(toolName string, category tools.ToolCategory, args map[string]any) (decision Decision) {
	defer func() {
		if r := recover(); r != nil {
			decision = Decision{Effect: Deny, Reason: fmt.Sprintf("Permission path resolution failed: %v", r)}
		}
	}()
	if c.Policy != nil {
		return c.Policy(namedTool{name: toolName, category: category}, args)
	}
	return c.checkAction(toolName, category, args)
}

type namedTool struct {
	name     string
	category tools.ToolCategory
}

func (t namedTool) Name() string                 { return t.name }
func (t namedTool) Description() string          { return "" }
func (t namedTool) Category() tools.ToolCategory { return t.category }
func (t namedTool) Schema() map[string]any       { return nil }
func (t namedTool) Execute(context.Context, map[string]any) tools.ToolResult {
	return tools.ToolResult{}
}

func (c *Checker) checkAction(toolName string, category tools.ToolCategory, args map[string]any) Decision {
	mode := c.Mode()
	content := ExtractContent(toolName, args)
	coordination := c.Teammate && TeammateCoordinationTools[toolName]
	filePath, _ := args["file_path"].(string)
	if filePath == "" {
		filePath, _ = args["path"].(string)
	}
	planControl := mode == ModePlan && PlanCoordinationTools[toolName]
	planFileWrite := false
	if mode == ModePlan && (toolName == "WriteFile" || toolName == "EditFile") && c.CurrentPlanPath() != "" {
		target, err1 := utils.CanonicalPath(utils.ResolveToolPath(c.Cwd(), filePath), 0)
		plan, err2 := utils.CanonicalPath(utils.ResolveToolPath(c.Cwd(), c.CurrentPlanPath()), 0)
		planFileWrite = err1 == nil && err2 == nil && target == plan
	}
	if mode == ModePlan && category != tools.CategoryRead && !coordination && !planControl &&
		!planFileWrite && !(category == tools.CategoryCommand && tools.IsSafeCommand(content)) {
		return Decision{Effect: Deny, Reason: "Plan mode forbids mutations"}
	}

	explicit := c.CheckExplicitRules(toolName, args)
	var explicitEffect DecisionEffect
	if explicit != nil {
		explicitEffect = explicit.Effect
		if explicit.Effect != Allow {
			return *explicit
		}
	}

	if planControl {
		return Decision{Effect: Allow, Reason: "Plan coordination tool"}
	}

	// Layer 1.5: teammate coordination — internal team messaging and the
	// shared task board. Explicit deny/ask rules above still gate them.
	if coordination {
		return Decision{Effect: Allow, Reason: "Teammate coordination tool"}
	}

	// Layer 0: plan-mode plan-file write exception. Both WriteFile and
	// EditFile targeting the plan file are allowed so the model can create
	// and update its plan.
	if planFileWrite {
		return Decision{Effect: Allow, Reason: "Plan file write allowed in plan mode"}
	}

	// Layer 2: safe read-only command auto-allow (metacharacter-guarded).
	if category == tools.CategoryCommand && tools.IsSafeCommand(content) {
		return Decision{Effect: Allow, Reason: "Safe read-only command"}
	}

	if (toolName == "Bash" || toolName == "PowerShell") && strings.TrimSpace(content) == "" {
		return Decision{Effect: Ask, Reason: "Approval requires a non-empty Bash command or PowerShell command"}
	}

	if (toolName == "Bash" || toolName == "PowerShell") &&
		!AnalyzeShell(content, toolName == "PowerShell").Complete && mode != ModeBypass {
		return Decision{Effect: Ask, Reason: "Complex shell syntax requires approval"}
	}

	// Sandbox auto-allow follows explicit deny/ask rules and shell syntax
	// checks. Only Bash is wrapped by the configured OS sandbox; other
	// command tools (e.g. PowerShell) never inherit this auto-allow.
	if c.SandboxEnabled && c.SandboxAutoAllow && toolName == "Bash" {
		return Decision{Effect: Allow, Reason: "Sandbox auto-allow: OS sandbox active"}
	}

	// Layer 4: only writes need path approval; reads and bypass mode skip it.
	if category == tools.CategoryWrite && filePath != "" && mode != ModeBypass && c.Sandbox != nil {
		if sandboxDecision := c.Sandbox.Check(utils.ResolveToolPath(c.Cwd(), filePath)); sandboxDecision != nil && explicitEffect != Allow {
			return Decision{Effect: Ask, Reason: sandboxDecision.Reason}
		}
	}

	// Layer 5: rule engine — per-tool content + glob match.
	if explicitEffect != "" {
		return Decision{Effect: explicitEffect, Reason: fmt.Sprintf("Permission rule: %s", explicitEffect)}
	}

	// Layer 6: mode matrix.
	return Decision{Effect: modeDecide(mode, category), Reason: fmt.Sprintf("Mode: %s", mode)}
}

func (c *Checker) insensitiveMatch(toolName string) bool {
	return toolName == "PowerShell" ||
		(filepath.Separator == '\\' && (FileTools[toolName] || toolName == "Glob"))
}

// CheckExplicitRules evaluates the merged rule snapshot against the call.
func (c *Checker) CheckExplicitRules(toolName string, args map[string]any) (decision *Decision) {
	defer func() {
		if err := recover(); err != nil {
			decision = &Decision{Effect: Deny, Reason: fmt.Sprintf("Permission path resolution failed: %v", err)}
		}
	}()
	snapshot, err := c.RuleEngine.Snapshot()
	if err != nil {
		return &Decision{Effect: Deny, Reason: fmt.Sprintf("Permission path resolution failed: %s", err)}
	}
	var rules []Rule
	for _, rule := range snapshot {
		if rule.Tool != toolName && rule.Tool != "*" {
			continue
		}
		pattern := rule.Pattern
		if FileTools[rule.Tool] || rule.Tool == "Glob" {
			normalized, err := normalizePathPattern(c.Cwd(), rule.Pattern)
			if err != nil {
				return &Decision{Effect: Deny, Reason: fmt.Sprintf("Permission path resolution failed: %s", err)}
			}
			pattern = normalized
		}
		rules = append(rules, Rule{Tool: rule.Tool, Pattern: pattern, Effect: rule.Effect})
	}
	rawContent := ExtractContent(toolName, args)
	insensitive := c.insensitiveMatch(toolName)
	var effect *RuleEffect
	if toolName == "Bash" || toolName == "PowerShell" {
		analysis := AnalyzeShell(rawContent, toolName == "PowerShell")
		effects := []*RuleEffect{EvaluateRules(rules, toolName, rawContent, insensitive)}
		for _, command := range analysis.Commands {
			effects = append(effects, EvaluateRules(rules, toolName, command.Content, insensitive))
			parts := shellPathSepRe.Split(command.Words[0], -1)
			base := parts[len(parts)-1]
			var restrictive []Rule
			for _, rule := range rules {
				if rule.Effect != Allow {
					restrictive = append(restrictive, rule)
				}
			}
			effects = append(effects, EvaluateRules(restrictive, toolName, strings.Join(append([]string{base}, command.Words[1:]...), " "), insensitive))
		}
		effect = nil
		for _, eff := range effects {
			if eff != nil && *eff == Deny {
				d := Deny
				effect = &d
				break
			}
		}
		if effect == nil && !analysis.Complete {
			var restrictive []Rule
			for _, rule := range rules {
				if (rule.Tool == toolName || rule.Tool == "*") && rule.Effect != Allow {
					restrictive = append(restrictive, rule)
				}
			}
			if len(restrictive) > 0 {
				d := Ask
				for _, rule := range restrictive {
					if rule.Effect == Deny {
						d = Deny
						break
					}
				}
				effect = &d
			}
		} else if effect == nil {
			for _, eff := range effects {
				if eff != nil && *eff == Ask {
					a := Ask
					effect = &a
					break
				}
			}
			if effect == nil && len(analysis.Commands) > 0 {
				allAllow := true
				for _, command := range analysis.Commands {
					eff := EvaluateRules(rules, toolName, command.Content, insensitive)
					if eff == nil || *eff != Allow {
						allAllow = false
						break
					}
				}
				if allAllow {
					a := Allow
					effect = &a
				}
			}
		}
	} else {
		content := rawContent
		if FileTools[toolName] && rawContent != "" {
			canonical, err := utils.CanonicalPath(utils.ResolveToolPath(c.Cwd(), rawContent), 0)
			if err != nil {
				return &Decision{Effect: Deny, Reason: fmt.Sprintf("Permission path resolution failed: %s", err)}
			}
			content = filepath.ToSlash(canonical)
		} else if toolName == "Glob" && rawContent != "" {
			pathArg, _ := args["path"].(string)
			if pathArg == "" {
				pathArg = "."
			}
			normalized, err := normalizePathPattern(utils.ResolveToolPath(c.Cwd(), pathArg), rawContent)
			if err != nil {
				return &Decision{Effect: Deny, Reason: fmt.Sprintf("Permission path resolution failed: %s", err)}
			}
			content = normalized
		}
		effect = EvaluateRules(rules, toolName, content, insensitive)
	}
	if effect == nil {
		return nil
	}
	return &Decision{Effect: *effect, Reason: fmt.Sprintf("Permission rule: %s", *effect)}
}

// RememberPatterns derives the rule patterns offered for "allow always".
func (c *Checker) RememberPatterns(toolName string, args map[string]any) []string {
	content := ExtractContent(toolName, args)
	if content == "" {
		return nil
	}
	if FileTools[toolName] {
		abs, err := utils.CanonicalPath(utils.ResolveToolPath(c.Cwd(), content), 0)
		if err != nil {
			return nil
		}
		isDir := false
		if info, err := os.Stat(abs); err == nil {
			isDir = info.IsDir()
		}
		base := abs
		if !isDir {
			base = filepath.Dir(abs)
		}
		pattern := strings.TrimSuffix(filepath.ToSlash(base), "/")
		return []string{fmt.Sprintf("%s(%s/*)", toolName, escapeRuleLiteral(pattern))}
	}
	if toolName == "Bash" || toolName == "PowerShell" {
		analysis := AnalyzeShell(content, toolName == "PowerShell")
		if !analysis.Complete {
			return nil
		}
		wordFlagRe := regexp.MustCompile(`[\s*?\\]`)
		for _, command := range analysis.Commands {
			for _, word := range command.Words[:minInt(2, len(command.Words))] {
				if wordFlagRe.MatchString(word) {
					return nil
				}
			}
		}
		seen := map[string]bool{}
		var patterns []string
		for _, command := range analysis.Commands {
			prefix := strings.Join(command.Words[:minInt(2, len(command.Words))], " ")
			pattern := fmt.Sprintf("%s(%s*)", toolName, escapeRuleLiteral(prefix))
			if !seen[pattern] {
				seen[pattern] = true
				patterns = append(patterns, pattern)
			}
		}
		return patterns
	}
	if toolName == tools.McpCallToolName {
		server, _ := args["server"].(string)
		tool, _ := args["tool"].(string)
		if server == "" || tool == "" {
			return nil
		}
	}
	if toolName == tools.McpCallToolName || toolName == "WebFetch" || toolName == "InstallSkill" || toolName == "TaskOutput" {
		return []string{fmt.Sprintf("%s(%s)", toolName, escapeRuleLiteral(content))}
	}
	return nil
}

// AllowAlways persists allow rules for the call so it is not asked again.
func (c *Checker) AllowAlways(toolName string, args map[string]any, patterns []string) error {
	if patterns == nil {
		patterns = c.RememberPatterns(toolName, args)
	}
	for _, pattern := range patterns {
		match := RuleRE.FindStringSubmatch(pattern)
		if match != nil && match[1] == toolName {
			if err := c.RuleEngine.AppendProjectRule(Rule{Tool: match[1], Pattern: match[2], Effect: Allow}); err != nil {
				return err
			}
		}
	}
	return nil
}

func minInt(a, b int) int {
	if a < b {
		return a
	}
	return b
}

// DescribeToolAction generates a human-readable description of the tool
// action for display in HITL confirmation dialogs. It prefers the per-tool
// match content from ExtractContent (e.g., command, file_path, or McpCall's
// server__tool); falls back to a key:value summary of parameters when there
// is none.
func DescribeToolAction(toolName string, args map[string]any) string {
	if content := ExtractContent(toolName, args); content != "" {
		return content
	}
	keys := make([]string, 0, len(args))
	for k := range args {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	var parts []string
	for _, k := range keys {
		v := args[k]
		s := fmt.Sprintf("%v", v)
		if len(s) > MaxActionArgValueChars {
			s = s[:MaxActionArgValueChars] + "..."
		}
		parts = append(parts, fmt.Sprintf("%s: %s", k, s))
	}
	return strings.Join(parts, ", ")
}

// IsSafeCommand reports whether a command is safe read-only (no approval
// needed). Delegates to the tools package where the reference semantics are
// implemented.
func IsSafeCommand(command string) bool { return tools.IsSafeCommand(command) }

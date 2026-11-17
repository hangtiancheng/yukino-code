package tools

import (
	"context"
)

var SkipDirs = map[string]bool{
	".agents": true, ".git": true, ".yukino": true, ".next": true, ".venv": true, ".mypy_cache": true, "__pycache__": true, "dist": true, "node_modules": true,
}

const MaxOutputChars = 50000

type ToolResult struct {
	Output        string
	IsError       bool
	ContentBlocks []map[string]any
	McpApp        *McpAppResult
}

// McpAppResult is the rich MCP Apps metadata preserved on a tool result for
// hosts that render the app in a panel.
type McpAppResult struct {
	ServerName  string         `json:"serverName"`
	ToolName    string         `json:"toolName"`
	ResourceURI string         `json:"resourceUri"`
	Arguments   map[string]any `json:"arguments"`
	Result      any            `json:"result"`
}

type McpLoadingMode string

const (
	McpLoadingEager    McpLoadingMode = "eager"
	McpLoadingNative   McpLoadingMode = "native"
	McpLoadingDispatch McpLoadingMode = "dispatch"
)

type MCPTool interface {
	Tool
	MCPServerName() string
	MCPInputSchema() map[string]any
	SetDeferLoading(bool)
}

const ToolSearchToolName = "ToolSearch"

type ToolCategory string

const (
	CategoryRead    ToolCategory = "read"
	CategoryWrite   ToolCategory = "write"
	CategoryCommand ToolCategory = "command"
)

type Tool interface {
	Name() string
	Description() string
	Category() ToolCategory
	Schema() map[string]any
	Execute(ctx context.Context, args map[string]any) ToolResult
}

type DeferrableTool interface {
	ShouldDefer() bool
}

type ConcurrencySafeTool interface {
	IsConcurrencySafe(args map[string]any) bool
}

func IsConcurrencySafe(t Tool, args map[string]any) bool {
	if cs, ok := t.(ConcurrencySafeTool); ok {
		return cs.IsConcurrencySafe(args)
	}
	return t.Category() == CategoryRead
}

type DefaultTools struct {
	Registry  *Registry
	WriteFile *WriteFileTool
	EditFile  *EditFileTool
}

func CreateDefaultRegistry() *Registry {
	dt := CreateDefaultTools()
	return dt.Registry
}

func CreateDefaultToolsWithWorkDir(workDir string) DefaultTools {
	fsc := NewFileStateCache()
	wf := &WriteFileTool{FileStateCache: fsc}
	ef := &EditFileTool{FileStateCache: fsc}
	reg := NewRegistry()
	reg.Register(&ReadFileTool{FileStateCache: fsc})
	reg.Register(wf)
	reg.Register(ef)
	reg.Register(&BashTool{WorkDir: workDir})
	reg.Register(&PowerShellTool{})
	reg.Register(NewComputerUseTool(ComputerUseOptions{}))
	reg.Register(&TaskOutputTool{})
	reg.Register(&GlobTool{})
	reg.Register(&GrepTool{})
	reg.Register(&WebFetchTool{})
	reg.Register(&ExitPlanModeTool{})
	reg.Register(&EnterPlanModeTool{Registry: reg})
	return DefaultTools{Registry: reg, WriteFile: wf, EditFile: ef}
}

func CreateDefaultTools() DefaultTools {
	return CreateDefaultToolsWithWorkDir("")
}

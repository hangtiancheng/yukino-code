// Package github exposes github_tool, which forwards arguments verbatim to the
// local gh CLI.
package github

import (
	"context"
	"encoding/base64"
	"net/url"
	"os"
	"strings"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/hangtiancheng/yukino-code/apps/mcp-go/internal/config"
	"github.com/hangtiancheng/yukino-code/apps/mcp-go/internal/tools"
	"github.com/hangtiancheng/yukino-code/apps/mcp-go/internal/tools/operations"
)

const description = "Run any GitHub CLI (gh) command. Supply args without the leading gh, e.g. [\"pr\",\"list\",\"--repo\",\"owner/repo\",\"--json\",\"number,title\"]. Covers repositories, issues, PRs/reviews/merges, Actions, releases/assets, projects and every REST/GraphQL endpoint via gh api. Use --help to discover commands, --json/--jq for focused results, and gh api --paginate --slurp for pagination. stdin supports --input - (JSON/binary-as-text payloads), --body-file - and other stdin-based flags. cwd selects the local repository for checkout/clone/git operations. No command allowlist or confirmation step. Requires gh on PATH; authentication uses github.token/github.hostname in JSON configuration or gh auth login (native gh environment authentication is also supported). Returns stdout, stderr, exit_code, signal, timed_out and cancelled; nonzero exits, timeouts or cancellation are errors. Use response_format=base64 for binary stdout."

// Input is the github_tool argument schema.
type Input struct {
	Args           []string `json:"args" jsonschema:"Ordered gh arguments without the executable name. Each element is one argument, sent verbatim without shell parsing."`
	Cwd            string   `json:"cwd,omitempty" jsonschema:"Working directory; defaults to the MCP process directory."`
	Stdin          string   `json:"stdin,omitempty" jsonschema:"Text sent verbatim to stdin, e.g. a JSON body for gh api --input -."`
	TimeoutMS      int      `json:"timeout_ms,omitempty" jsonschema:"Subprocess timeout in milliseconds; increase for long-running commands. Defaults to 60000."`
	ResponseFormat string   `json:"response_format,omitempty" jsonschema:"Encoding of stdout; base64 preserves binary API downloads. Defaults to text."`
}

// Module returns the github tool module.
func Module() tools.ToolModule {
	return tools.ToolModule{
		Name: "github",
		Register: func(server *mcp.Server) {
			tools.AddTool(server, &mcp.Tool{
				Name:        tools.GitHubTool,
				Title:       "GitHub CLI",
				Description: description,
				Annotations: operations.UnrestrictedAnnotations,
			}, handle)
		},
	}
}

func handle(ctx context.Context, _ *mcp.CallToolRequest, in Input) (*mcp.CallToolResult, any, error) {
	if len(in.Args) == 0 {
		return operations.ResultErr(tools.GitHubTool, errString("args must contain at least one argument")), nil, nil
	}
	format := in.ResponseFormat
	if format == "" {
		format = "text"
	}
	if format != "text" && format != "base64" {
		return operations.ResultErr(tools.GitHubTool, errString("response_format must be text or base64")), nil, nil
	}
	result, err := RunGh(ctx, in.Args, GhOptions{
		Cwd:       in.Cwd,
		Stdin:     in.Stdin,
		TimeoutMS: in.TimeoutMS,
		Env:       ghEnvironment(),
	})
	if err != nil {
		if IsNotFound(err) {
			return operations.ResultErr(tools.GitHubTool, errString("Unable to start gh. Install GitHub CLI and ensure gh is on PATH; check cwd if supplied. Authenticate with gh auth login or configure github.token in JSON.")), nil, nil
		}
		return operations.ResultErr(tools.GitHubTool, err), nil, nil
	}
	stdout := operations.DecodeUTF8(result.Stdout)
	if format == "base64" {
		stdout = base64.StdEncoding.EncodeToString(result.Stdout)
	}
	var signal any
	if result.Signal != "" {
		signal = result.Signal
	}
	var exitCode any
	if result.ExitCode >= 0 {
		exitCode = result.ExitCode
	}
	res := operations.Result(map[string]any{
		"stdout":    stdout,
		"stderr":    operations.DecodeUTF8([]byte(result.Stderr)),
		"exit_code": exitCode,
		"signal":    signal,
		"timed_out": result.TimedOut,
		"cancelled": result.Cancelled,
	})
	if result.ExitCode != 0 || result.TimedOut || result.Cancelled {
		operations.WithError(res)
	}
	return res, nil, nil
}

func ghEnvironment() []string {
	cfg := config.Load().GitHub
	env := make(map[string]string)
	for _, pair := range os.Environ() {
		k, v, ok := strings.Cut(pair, "=")
		if ok {
			env[k] = v
		}
	}
	env["GH_PROMPT_DISABLED"] = "1"
	env["GH_PAGER"] = "cat"
	hostname := cfg.Hostname
	if hostname == "" && cfg.BaseURL != "" {
		if parsed, err := url.Parse(cfg.BaseURL); err == nil {
			hostname = parsed.Host
		}
	}
	if hostname != "" {
		if hostname == "api.github.com" {
			env["GH_HOST"] = "github.com"
		} else {
			env["GH_HOST"] = hostname
		}
	}
	if cfg.Token != "" {
		enterprise := hostname != "" && hostname != "github.com" && hostname != "api.github.com" && !strings.HasSuffix(hostname, ".ghe.com")
		if enterprise {
			env["GH_ENTERPRISE_TOKEN"] = cfg.Token
		} else {
			env["GH_TOKEN"] = cfg.Token
		}
	}
	out := make([]string, 0, len(env))
	for k, v := range env {
		out = append(out, k+"="+v)
	}
	return out
}

type stringError string

func (e stringError) Error() string { return string(e) }

func errString(msg string) error { return stringError(msg) }

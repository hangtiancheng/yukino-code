// Package createapp exposes create_app. The host renders a self-contained HTML
// document inside the MCP App shell.
//
// The shell is embedded static HTML. html/template fills only the default title.
// The model-supplied document stays in the tool result _meta and is written by
// the browser shell into a sandboxed iframe; it is not passed through the template.
package createapp

import (
	"bytes"
	"context"
	_ "embed"
	"html/template"
	"strconv"
	"sync"
	"unicode/utf8"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/hangtiancheng/yukino-code/apps/dejavu/internal/logger"
	"github.com/hangtiancheng/yukino-code/apps/dejavu/internal/tools"
)

// ResourceURI is the UI shell resource fetched by the host.
const ResourceURI = "ui://create-app/create-app.html"

const (
	resourceMIME  = "text/html;profile=mcp-app"
	maxHTMLChars  = 200_000
	fallbackTitle = "MCP App"
	noUIFallback  = "Agentic app delivered via the create_app UI; hosts without MCP Apps support cannot display it."
)

//go:embed shell.html.tmpl
var shellTemplate string

var resourceDomains = []string{
	"https://unpkg.com",
	"https://cdn.jsdelivr.net",
	"https://cdn.tailwindcss.com",
	"https://cdnjs.cloudflare.com",
	"https://esm.sh",
	"https://fonts.googleapis.com",
	"https://fonts.gstatic.com",
}

// Input is the create_app argument schema.
type Input struct {
	HTML  string `json:"html" jsonschema:"Complete, self-contained HTML document to render. Scripts run in a sandboxed iframe. Keep it under 200000 characters."`
	Title string `json:"title,omitempty" jsonschema:"Short human-readable label shown above the app. Defaults to MCP App."`
}

const description = "Create a complete HTML document as an interactive app (MCP App) inline in the conversation. Use it whenever the user wants to see or interact with a result rather than read text: charts, dashboards, diagrams, calculators, small simulations, games or forms. The HTML must be self-contained (inline CSS/JS); it runs in a sandboxed iframe, so there is no storage, cookies or access to the host. Returns app metadata; UI-capable hosts display the app automatically."

// Module returns the create_app tool module.
func Module() tools.ToolModule {
	return tools.ToolModule{
		Name: "create_app",
		Register: func(server *mcp.Server) {
			tools.AddTool(server, &mcp.Tool{
				Name:        tools.CreateApp,
				Title:       "MCP App",
				Description: description,
				Meta: mcp.Meta{
					"ui":             map[string]any{"resourceUri": ResourceURI},
					"ui/resourceUri": ResourceURI,
				},
				Annotations: &mcp.ToolAnnotations{
					ReadOnlyHint:    true,
					DestructiveHint: boolPtr(false),
					IdempotentHint:  true,
					OpenWorldHint:   boolPtr(true),
				},
			}, handle)
			server.AddResource(&mcp.Resource{
				URI:         ResourceURI,
				Name:        "Create App UI",
				Title:       "Create App UI",
				Description: "Sandboxed shell that displays the create_app tool result as an interactive app.",
				MIMEType:    resourceMIME,
			}, readShell)
		},
	}
}

func handle(_ context.Context, _ *mcp.CallToolRequest, in Input) (*mcp.CallToolResult, any, error) {
	if in.HTML == "" {
		return textError("html is required"), nil, nil
	}
	if utf8.RuneCountInString(in.HTML) > maxHTMLChars {
		return textError("html exceeds 200000 characters"), nil, nil
	}
	title := in.Title
	if title == "" {
		title = fallbackTitle
	}
	if utf8.RuneCountInString(title) > 120 {
		return textError("title exceeds 120 characters"), nil, nil
	}
	if _, err := ShellHTML(); err != nil {
		return textError(err.Error()), nil, nil
	}
	logger.Debug("create_app invoked", "bytes", len(in.HTML), "title", title)
	return &mcp.CallToolResult{
		Content: []mcp.Content{&mcp.TextContent{
			Text: "Rendered interactive app \"" + title + "\". " + noUIFallback,
		}},
		StructuredContent: map[string]any{"title": title},
		Meta:              mcp.Meta{"html": in.HTML, "title": title},
	}, nil, nil
}

func readShell(context.Context, *mcp.ReadResourceRequest) (*mcp.ReadResourceResult, error) {
	html, err := ShellHTML()
	if err != nil {
		return nil, err
	}
	return &mcp.ReadResourceResult{
		Contents: []*mcp.ResourceContents{{
			URI:      ResourceURI,
			MIMEType: resourceMIME,
			Text:     html,
			Meta: mcp.Meta{"ui": map[string]any{"csp": map[string]any{
				"resourceDomains": resourceDomains,
			}}},
		}},
	}, nil
}

var (
	shellOnce sync.Once
	shellHTML string
	shellErr  error
)

// ShellHTML renders the embedded UI shell. The model HTML is not part of that render.
func ShellHTML() (string, error) {
	shellOnce.Do(func() {
		tmpl, err := template.New("shell").Parse(shellTemplate)
		if err != nil {
			shellErr = err
			return
		}
		var buf bytes.Buffer
		err = tmpl.Execute(&buf, map[string]any{
			"FallbackTitle":   fallbackTitle,
			"FallbackTitleJS": template.JS(strconv.Quote(fallbackTitle)),
		})
		if err != nil {
			shellErr = err
			return
		}
		shellHTML = buf.String()
	})
	return shellHTML, shellErr
}

func textError(msg string) *mcp.CallToolResult {
	return &mcp.CallToolResult{
		Content: []mcp.Content{&mcp.TextContent{Text: msg}},
		IsError: true,
	}
}

func boolPtr(v bool) *bool { return &v }

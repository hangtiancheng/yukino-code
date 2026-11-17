package ui

import (
	"strings"

	"github.com/alecthomas/chroma/v2"
	"github.com/alecthomas/chroma/v2/lexers"
)

var syntaxLanguages = strings.Fields("bash c c# c++ cjs clj clojure coffee coffeescript console cpp cpp-macro cs csharp css csv cts dart diff docker dockerfile elixir erl erlang f# fs fsharp glsl go gql graphql groovy haml haskell hcl hs html html-derivative http ini java javascript js json jsonc jsx kotlin kt kts less log lua make makefile markdown markdown-vue md mjs mts objc objective-c ocaml perl php plain plaintext postcss powershell prisma properties proto protobuf ps ps1 pwsh py python r rb regex regexp rs ruby rust scala scss sh shell shellscript shellsession sql svelte swift text toml ts tsx txt typescript vim viml vimscript vue vue-directives vue-interpolations vue-sfc-style-variable-injection xml yaml yml zig zsh")

func highlightCode(code, language string) string {
	normalized := strings.ToLower(language)
	supported := false
	for _, candidate := range syntaxLanguages {
		if candidate == normalized {
			supported = true
			break
		}
	}
	if !supported {
		return paint(code, Theme.MdCodeBlock)
	}
	if normalized == "text" || normalized == "txt" || normalized == "plain" || normalized == "plaintext" {
		return paint(code, Theme.Text)
	}
	lexer := lexers.Get(normalized)
	if lexer == nil {
		return paint(code, Theme.MdCodeBlock)
	}
	iterator, err := chroma.Coalesce(lexer).Tokenise(nil, code)
	if err != nil {
		return paint(code, Theme.MdCodeBlock)
	}
	var sb strings.Builder
	for _, token := range iterator.Tokens() {
		color := Theme.Text
		switch {
		case token.Type.InCategory(chroma.Comment):
			color = Theme.SyntaxComment
		case token.Type.InCategory(chroma.Keyword):
			color = Theme.SyntaxKeyword
		case token.Type == chroma.NameFunction || token.Type == chroma.NameBuiltin:
			color = Theme.SyntaxFunction
		case token.Type.InSubCategory(chroma.NameVariable):
			color = Theme.SyntaxVariable
		case token.Type.InSubCategory(chroma.LiteralString):
			color = Theme.SyntaxString
		case token.Type.InSubCategory(chroma.LiteralNumber):
			color = Theme.SyntaxNumber
		case token.Type == chroma.NameClass || token.Type == chroma.NameNamespace || token.Type == chroma.NameTag:
			color = Theme.SyntaxType
		case token.Type.InCategory(chroma.Operator):
			color = Theme.SyntaxOperator
		case token.Type.InCategory(chroma.Punctuation):
			color = Theme.SyntaxPunctuation
		case token.Type == chroma.GenericInserted:
			color = Theme.ToolDiffAdded
		case token.Type == chroma.GenericDeleted:
			color = Theme.ToolDiffRemoved
		}
		sb.WriteString(paint(token.Value, color))
	}
	return sb.String()
}

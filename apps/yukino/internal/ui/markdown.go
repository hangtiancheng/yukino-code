package ui

import (
	"fmt"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf16"

	"github.com/charmbracelet/lipgloss"
	"github.com/charmbracelet/x/ansi"
	"github.com/yuin/goldmark"
	"github.com/yuin/goldmark/ast"
	"github.com/yuin/goldmark/extension"
	ext "github.com/yuin/goldmark/extension/ast"
	"github.com/yuin/goldmark/text"
)

var terminalMarkdown = goldmark.New(goldmark.WithExtensions(extension.GFM))
var markdownReference = regexp.MustCompile("\\[[^\\]\\n]+\\](?:[^\\(]|$)")
var sourceListMarker = regexp.MustCompile("^[ \\t]*(\\d+[.)])[ \\t]+")
var unsafeLinkProtocol = regexp.MustCompile("[^a-zA-Z0-9_:]")

type markdownRenderer struct {
	source    []byte
	width     int
	kind      string
	streaming bool
}

func (m Model) renderMarkdown(content string) string {
	return renderMarkdownText(content, max(1, m.width-boolColumn(m.width > 2)*2), "assistant", false)
}

func renderMarkdownText(content string, width int, kind string, streaming bool) string {
	source := []byte(plainTerminalText(content))
	result := renderMarkdownSource(source, width, kind, streaming, true)
	result = strings.Join(wrapToLines(result, width), "\n")
	if kind == "thinking" {
		result = ansiStyle(result, "\x1b[3m", "\x1b[23m")
	}
	return result
}

// renderMarkdownSource parses and renders without the final wrap, shared by
// renderMarkdownText and the streaming prefix cache. trim mirrors the
// reference: renderMarkdown trims the rendered document before wrapping, but
// the streaming cache and tail keep block-trailing newlines so the joined
// blocks stay separated.
func renderMarkdownSource(source []byte, width int, kind string, streaming bool, trim bool) string {
	r := markdownRenderer{source: source, width: max(1, width), kind: kind, streaming: streaming}
	root := terminalMarkdown.Parser().Parse(text.NewReader(source))
	result := r.children(root)
	if trim {
		result = strings.TrimRightFunc(result, unicode.IsSpace)
	}
	return result
}

// markdownCache mirrors MarkdownCache in src/ui/markdown.ts.
type markdownCache struct {
	prefix   string
	rendered string
	width    int
	theme    string
}

// renderStreamingMarkdown mirrors src/ui/markdown.ts renderStreamingMarkdown:
// every complete block except the last is rendered once and cached by
// prefix+width+theme, so each streaming frame only re-renders the trailing
// partial block. Reference definitions can restyle earlier blocks, so they
// disable the cache entirely.
func renderStreamingMarkdown(content string, width int, cache *markdownCache) string {
	normalized := plainTerminalText(content)
	if markdownReference.MatchString(normalized) {
		cache.prefix = ""
		cache.rendered = ""
		return renderMarkdownText(normalized, width, "assistant", true)
	}
	source := []byte(normalized)
	root := terminalMarkdown.Parser().Parse(text.NewReader(source))
	prefixEnd := 0
	if last := root.LastChild(); last != nil && last != root.FirstChild() {
		if start := blockAwareLineStart(last, normalized, len(source)); start < len(normalized) {
			prefixEnd = start
		}
	}
	prefix := normalized[:prefixEnd]
	theme := fmt.Sprintf("%+v", Theme)
	if cache.prefix != prefix || cache.width != width || cache.theme != theme {
		cache.prefix = prefix
		cache.rendered = strings.Join(wrapToLines(renderMarkdownSource([]byte(prefix), width, "assistant", true, false), width), "\n")
		cache.width = width
		cache.theme = theme
	}
	tail := strings.Join(wrapToLines(renderMarkdownSource(source[len(prefix):], width, "assistant", true, false), width), "\n")
	return strings.TrimRightFunc(cache.rendered+tail, unicode.IsSpace)
}

func (r markdownRenderer) color() string {
	switch r.kind {
	case "thinking":
		return Theme.ThinkingText
	case "user":
		return Theme.UserMessageText
	}
	return Theme.Text
}
func (r markdownRenderer) children(n ast.Node) string {
	var sb strings.Builder
	for child := n.FirstChild(); child != nil; {
		if _, ok := child.(*ast.Text); ok {
			var value strings.Builder
			for child != nil {
				t, ok := child.(*ast.Text)
				if !ok {
					break
				}
				value.WriteString(r.textValue(t))
				child = child.NextSibling()
			}
			sb.WriteString(r.renderText(value.String()))
		} else {
			sb.WriteString(r.node(child))
			child = child.NextSibling()
		}
	}
	return sb.String()
}

func (r markdownRenderer) textValue(v *ast.Text) string {
	value := string(v.Segment.Value(r.source))
	if v.HardLineBreak() {
		return strings.TrimRight(value, " \t") + "\r"
	}
	if v.SoftLineBreak() {
		value += "\n"
	}
	return value
}

func (r markdownRenderer) renderText(value string) string {
	var sb strings.Builder
	for len(value) > 0 {
		match := markdownEscape.FindStringIndex(value)
		if match == nil {
			sb.WriteString(paint(value, r.color()))
			break
		}
		sb.WriteString(paint(value[:match[0]], r.color()))
		escaped := value[match[0]:match[1]]
		if r.kind != "user" {
			escaped = escaped[1:]
		}
		sb.WriteString(paint(escaped, r.color()))
		value = value[match[1]:]
	}
	return sb.String()
}
func (r markdownRenderer) lines(n ast.Node) string {
	var sb strings.Builder
	for i := 0; i < n.Lines().Len(); i++ {
		segment := n.Lines().At(i)
		sb.Write(segment.Value(r.source))
	}
	return sb.String()
}
func (r markdownRenderer) node(n ast.Node) string {
	switch v := n.(type) {
	case *ast.Text:
		return r.renderText(r.textValue(v))
	case *ast.String:
		return paint(string(v.Value), r.color())
	case *ast.Paragraph:
		return reflowMarkdown(paint(unescapeMarkdownEntities(r.children(n)), r.color()), r.width) + "\n\n"
	case *ast.TextBlock:
		return r.children(n)
	case *ast.Heading:
		style := lipgloss.NewStyle().Foreground(lipgloss.Color(Theme.MdHeading))
		switch v.Level {
		case 1:
			style = style.Bold(true).Underline(true)
		case 2:
			style = style.Bold(true)
		case 3:
			style = style.Bold(true).Italic(true)
		default:
			style = style.Italic(true)
		}
		return renderInlineStyle(style, r.children(n)) + "\n\n"
	case *ast.ThematicBreak:
		return paint(strings.Repeat("-", r.width), Theme.MdHr) + "\n\n"
	case *ast.Emphasis:
		style := lipgloss.NewStyle()
		if v.Level == 2 {
			style = style.Bold(true)
		} else {
			style = style.Italic(true)
		}
		return renderInlineStyle(style, r.children(n))
	case *ext.Strikethrough:
		return lipgloss.NewStyle().Strikethrough(true).Foreground(lipgloss.Color(Theme.Dim)).Render(r.children(n))
	case *ast.CodeSpan:
		var sb strings.Builder
		for child := n.FirstChild(); child != nil; child = child.NextSibling() {
			if t, ok := child.(*ast.Text); ok {
				sb.Write(t.Segment.Value(r.source))
				if t.SoftLineBreak() {
					sb.WriteByte(' ')
				}
			}
		}
		return paint(strings.ReplaceAll(sb.String(), "\n", " "), Theme.MdCode)
	case *ast.FencedCodeBlock:
		language := ""
		info := ""
		if v.Info != nil {
			info = string(v.Info.Segment.Value(r.source))
			fields := strings.Fields(info)
			if len(fields) > 0 {
				language = fields[0]
			}
		}
		body := strings.TrimSuffix(r.lines(n), "\n")
		if r.streaming && v.Lines().Len() > 0 {
			last := body[strings.LastIndex(body, "\n")+1:]
			start := nodeSourceStart(n, len(r.source))
			opening := ""
			if start > 0 {
				previous := strings.TrimRight(string(r.source[:start]), "\n")
				opening = previous[strings.LastIndex(previous, "\n")+1:]
			}
			opening = strings.TrimLeft(opening, " ")
			fenceLength := 0
			for fenceLength < len(opening) && (opening[fenceLength] == 96 || opening[fenceLength] == '~') {
				fenceLength++
			}
			if fenceLength >= 3 && len(last) > 0 && len(last) < fenceLength && strings.Trim(last, string(opening[0])) == "" {
				body = strings.TrimSuffix(strings.TrimSuffix(body, last), "\n")
			}
		}
		fence := strings.Repeat(string(rune(96)), 3)
		return paint(fence+info, Theme.MdCodeBlockBorder) + "\n" + indentLines(highlightCode(body, language), "  ") + "\n" + paint(fence, Theme.MdCodeBlockBorder) + "\n\n"
	case *ast.CodeBlock:
		return indentLines(highlightCode(strings.TrimSuffix(r.lines(n), "\n"), ""), "  ") + "\n\n"
	case *ast.Blockquote:
		body := strings.TrimRightFunc(r.children(n), unicode.IsSpace)
		var lines []string
		for _, line := range strings.Split(body, "\n") {
			for _, wrapped := range wrapWordsToLines(strings.TrimLeftFunc(line, unicode.IsSpace), max(1, r.width-2)) {
				lines = append(lines, paint("│", Theme.MdQuoteBorder)+" "+lipgloss.NewStyle().Italic(true).Foreground(lipgloss.Color(Theme.MdQuote)).Render(wrapped))
			}
		}
		return strings.Join(lines, "\n") + "\n\n"
	case *ast.List:
		var lines []string
		index := 0
		for item := n.FirstChild(); item != nil; item = item.NextSibling() {
			marker := "•"
			if v.IsOrdered() {
				marker = strconv.Itoa(v.Start+index) + "."
			}
			if r.kind == "user" {
				start := nodeSourceStart(item, len(r.source))
				lineStart := strings.LastIndex(string(r.source[:start]), "\n") + 1
				if match := sourceListMarker.FindStringSubmatch(string(r.source[lineStart:])); match != nil {
					marker = match[1]
				}
			}
			indent := visibleWidth(marker) + 1
			nested := r
			nested.width = max(1, r.width-indent)
			body := strings.TrimRightFunc(r.children(item), unicode.IsSpace)
			for i, line := range wrapWordsToLines(body, nested.width) {
				prefix := strings.Repeat(" ", indent)
				if i == 0 {
					prefix = paint(marker, Theme.MdListBullet) + " "
				}
				lines = append(lines, prefix+line)
			}
			index++
		}
		return strings.Join(lines, "\n") + "\n\n"
	case *ext.TaskCheckBox:
		if v.IsChecked {
			return "[x] [X] "
		}
		return "[ ] [ ] "
	case *ast.Link:
		return r.link(string(v.Destination), r.children(n), false)
	case *ast.AutoLink:
		href := string(v.URL(r.source))
		label := string(v.Label(r.source))
		return r.link(href, label, v.AutoLinkType == ast.AutoLinkEmail)
	case *ast.Image:
		label := string(v.Text(r.source))
		if len(v.Title) > 0 {
			label += " – " + string(v.Title)
		}
		return "![" + label + "](" + string(v.Destination) + ")\n"
	case *ast.RawHTML:
		var sb strings.Builder
		for i := 0; i < v.Segments.Len(); i++ {
			seg := v.Segments.At(i)
			sb.Write(seg.Value(r.source))
		}
		return paint(sb.String(), Theme.Muted)
	case *ast.HTMLBlock:
		value := r.lines(n)
		if v.HasClosure() {
			value += string(v.ClosureLine.Value(r.source))
		}
		return paint(value, Theme.Muted)
	case *ext.Table:
		var rows [][]string
		for row := v.FirstChild(); row != nil; row = row.NextSibling() {
			var cells []string
			for cell := row.FirstChild(); cell != nil; cell = cell.NextSibling() {
				cells = append(cells, r.children(cell))
			}
			rows = append(rows, cells)
		}
		fitted, widths, ok := fitTableToWidth(rows, len(v.Alignments), r.width)
		if !ok {
			start, end := nodeSourceRange(n, len(r.source))
			start = strings.LastIndex(string(r.source[:start]), "\n") + 1
			if next := strings.IndexByte(string(r.source[end:]), '\n'); next >= 0 {
				end += next
			} else {
				end = len(r.source)
			}
			return paint(strings.Join(wrapToLines(strings.TrimRightFunc(string(r.source[start:end]), unicode.IsSpace), r.width), "\n"), r.color()) + "\n\n"
		}
		return renderTable(fitted, widths) + "\n\n"
	}
	return r.children(n)
}

func (r markdownRenderer) link(href, label string, email bool) string {
	decoded, err := url.PathUnescape(href)
	if err != nil {
		return ""
	}
	protocol := strings.ToLower(unsafeLinkProtocol.ReplaceAllString(decoded, ""))
	if strings.HasPrefix(protocol, "javascript:") {
		return ""
	}
	// Mirrors the reference link renderer: on hyperlink-capable terminals the
	// styled text becomes a clickable OSC-8 link instead of the "text (url)"
	// fallback.
	if supportsHyperlinks() {
		linkText := label
		if linkText == "" {
			linkText = href
		}
		styled := ansiStyle(paint(linkText, Theme.MdLinkURL), "\x1b[4m", "\x1b[24m")
		return paint(osc8Link(styled, oscSafeHref(href)), Theme.MdLink)
	}
	if email {
		// An scp-style git remote (user@host:path) must stay verbatim plain text;
		// GFM's autolinker otherwise splits the user@host part into a mailto link.
		// The reference claims such remotes with a tokenizer ahead of the email
		// rule; goldmark's Linkify has already produced the email node here, so
		// detect the ":<non-space>" tail in the source and render it plain.
		if r.isScpStyleRemote(label) {
			return paint(label, r.color())
		}
		return paint(label, Theme.MdLinkURL)
	}
	if plainTerminalText(label) == href || label == "" {
		return paint(href, Theme.MdLinkURL)
	}
	return paint(label+" ("+paint(href, Theme.MdLinkURL)+")", Theme.MdLink)
}

// isScpStyleRemote reports whether the email autolink label is immediately
// followed by ":<non-space>" anywhere in the source, i.e. it is really an
// scp-style git remote (user@host:path) rather than a plain email address.
func (r markdownRenderer) isScpStyleRemote(label string) bool {
	needle := label + ":"
	source := string(r.source)
	for idx := 0; idx < len(source); {
		i := strings.Index(source[idx:], needle)
		if i < 0 {
			return false
		}
		pos := idx + i + len(needle)
		if pos < len(source) && !unicode.IsSpace(rune(source[pos])) {
			return true
		}
		idx += i + 1
	}
	return false
}

var markdownEscape = regexp.MustCompile("\\\\" + "[" + regexp.QuoteMeta("!\"#$%&'()*+,-./:;<=>?@[\\]^_"+string(rune(96))+"{|}~") + "]")

func unescapeMarkdownEntities(value string) string {
	return strings.NewReplacer("&amp;", "&", "&lt;", "<", "&gt;", ">", "&quot;", "\"", "&#39;", "'").Replace(value)
}
func indentLines(value, prefix string) string {
	return prefix + strings.ReplaceAll(value, "\n", "\n"+prefix)
}
func nodeSourceRange(n ast.Node, fallback int) (int, int) {
	start, end := fallback, 0
	if n.Type() == ast.TypeBlock {
		for i := 0; i < n.Lines().Len(); i++ {
			seg := n.Lines().At(i)
			start = min(start, seg.Start)
			end = max(end, seg.Stop)
		}
	}
	if t, ok := n.(*ast.Text); ok {
		start = min(start, t.Segment.Start)
		end = max(end, t.Segment.Stop)
	}
	for child := n.FirstChild(); child != nil; child = child.NextSibling() {
		a, b := nodeSourceRange(child, fallback)
		start = min(start, a)
		end = max(end, b)
	}
	return start, end
}
func nodeSourceStart(n ast.Node, fallback int) int {
	start, _ := nodeSourceRange(n, fallback)
	return start
}

var codeFenceLine = regexp.MustCompile("^ {0,3}(`{3,}|~{3,})")

// blockAwareLineStart returns the line-boundary source offset where the
// top-level node begins. Goldmark's Lines() segments for a fenced code block
// cover only the inner content, so the opening fence line is added back by
// scanning the previous line — without it a prefix split would cut the block
// in half (the reference's marked tokens carry the full raw block).
func blockAwareLineStart(n ast.Node, source string, fallback int) int {
	start := nodeSourceStart(n, fallback)
	if start >= len(source) {
		return len(source)
	}
	lineStart := strings.LastIndex(source[:start], "\n") + 1
	if _, ok := n.(*ast.FencedCodeBlock); ok && lineStart > 0 {
		prevStart := strings.LastIndex(source[:lineStart-1], "\n") + 1
		prevLine := strings.TrimRight(source[prevStart:lineStart-1], "\r")
		if codeFenceLine.MatchString(prevLine) {
			lineStart = prevStart
		}
	}
	return lineStart
}

func stableStreamingPrefix(value string) string {
	if len(utf16.Encode([]rune(value))) < 2048 || markdownReference.MatchString(value) {
		return ""
	}
	source := []byte(value)
	root := terminalMarkdown.Parser().Parse(text.NewReader(source))
	last := root.LastChild()
	if last == nil || last == root.FirstChild() {
		return ""
	}
	start := blockAwareLineStart(last, string(source), len(source))
	if start == len(source) {
		return ""
	}
	return string(source[:start])
}

func fitTableToWidth(rows [][]string, columns, width int) ([][]string, []int, bool) {
	available := width - (columns + 1)
	minimum := make([]int, columns)
	widths := make([]int, columns)
	for col := range columns {
		widest, cellWidth := 1, 0
		for _, row := range rows {
			cell := ""
			if col < len(row) {
				cell = row[col]
			}
			for _, line := range strings.Split(expandTabs(cell), "\n") {
				cellWidth = max(cellWidth, visibleWidth(line))
			}
			runes := []rune(plainTerminalText(cell))
			bounds := graphemeBounds(string(runes))
			for i := 0; i < len(bounds)-1; i++ {
				widest = max(widest, visibleWidth(string(runes[bounds[i]:bounds[i+1]])))
			}
		}
		minimum[col] = widest + 2
		widths[col] = max(minimum[col], cellWidth+2)
	}
	sum := func(values []int) int {
		total := 0
		for _, v := range values {
			total += v
		}
		return total
	}
	if columns < 1 || available < sum(minimum) {
		return nil, nil, false
	}
	for total := sum(widths); total > available; total-- {
		widest := -1
		for col, value := range widths {
			if value > minimum[col] && (widest < 0 || value > widths[widest]) {
				widest = col
			}
		}
		if widest < 0 {
			return nil, nil, false
		}
		widths[widest]--
	}
	wrapped := make([][]string, len(rows))
	for i, row := range rows {
		wrapped[i] = make([]string, columns)
		for col := range columns {
			value := ""
			if col < len(row) {
				value = row[col]
			}
			wrapped[i][col] = strings.Join(wrapWordsToLines(expandTabs(value), widths[col]-2), "\n")
		}
	}
	return wrapped, widths, true
}
func renderTable(rows [][]string, widths []int) string {
	columns := 0
	for _, row := range rows {
		columns = max(columns, len(row))
	}
	if columns == 0 {
		return ""
	}
	if widths == nil {
		widths = make([]int, columns)
		for col := range columns {
			for _, row := range rows {
				if col < len(row) {
					for _, line := range strings.Split(row[col], "\n") {
						widths[col] = max(widths[col], visibleWidth(line))
					}
				}
			}
			widths[col] += 2
		}
	}
	border := func(left, mid, right string) string {
		parts := make([]string, columns)
		for col := range columns {
			parts[col] = strings.Repeat("─", widths[col])
		}
		return paint(left+strings.Join(parts, mid)+right, Theme.Muted)
	}
	lines := []string{border("┌", "┬", "┐")}
	for i, row := range rows {
		if i > 0 {
			lines = append(lines, border("├", "┼", "┤"))
		}
		cells := make([][]string, columns)
		height := 1
		for col := range columns {
			value := ""
			if col < len(row) {
				value = row[col]
			}
			cells[col] = strings.Split(value, "\n")
			height = max(height, len(cells[col]))
		}
		for line := range height {
			parts := make([]string, columns)
			for col := range columns {
				value := ""
				if line < len(cells[col]) {
					value = cells[col][line]
				}
				w := max(0, widths[col]-2)
				value = truncateToWidth(value, w, "…")
				value = " " + value + strings.Repeat(" ", max(0, w-visibleWidth(value))) + " "
				if i == 0 {
					value = paint(value, Theme.MdHeading)
				}
				parts[col] = value
			}
			vertical := paint("│", Theme.Muted)
			lines = append(lines, vertical+strings.Join(parts, vertical)+vertical)
		}
	}
	return strings.Join(append(lines, border("└", "┴", "┘")), "\n")
}

func renderInlineStyle(style lipgloss.Style, value string) string {
	lines := strings.Split(value, "\n")
	for i, line := range lines {
		lines[i] = style.Render(line)
	}
	return strings.Join(lines, "\n")
}

var markdownWordBreak = regexp.MustCompile("[ \\t\\n]+")

func reflowMarkdown(value string, width int) string {
	var result []string
	for _, section := range strings.Split(strings.ReplaceAll(value, "<br />", "\r"), "\r") {
		var fragments []string
		for _, token := range terminalTokens(section) {
			if token.escape {
				fragments = append(fragments, token.value, "")
			} else if len(fragments) == 0 {
				fragments = append(fragments, token.value)
			} else {
				fragments[len(fragments)-1] += token.value
			}
		}
		column := 0
		line := ""
		lastEscape := false
		for _, fragment := range fragments {
			if fragment == "" {
				lastEscape = false
				continue
			}
			if visibleWidth(fragment) == 0 {
				line += fragment
				lastEscape = true
				continue
			}
			for _, word := range markdownWordBreak.Split(fragment, -1) {
				space := column != 0 && !lastEscape
				w := visibleWidth(word)
				if column+w+boolColumn(space) > width {
					if w <= width {
						result = append(result, line)
						line = word
						column = w
					} else {
						if space {
							line += " "
							column++
						}
						for word != "" {
							available := width - column
							if available <= 0 {
								result = append(result, line)
								line = ""
								column = 0
								continue
							}
							chunk := ansi.Cut(word, 0, available)
							if chunk == "" {
								tokens := terminalTokens(word)
								if len(tokens) == 0 {
									break
								}
								chunk = tokens[0].value
							}
							line += chunk
							column += visibleWidth(chunk)
							word = strings.TrimPrefix(word, chunk)
							if word != "" {
								result = append(result, line)
								line = ""
								column = 0
							}
						}
					}
				} else {
					if space {
						line += " "
						column++
					}
					line += word
					column += w
				}
				lastEscape = false
			}
		}
		if visibleWidth(line) > 0 {
			result = append(result, line)
		}
	}
	return strings.Join(result, "\n")
}

package memory

import (
	"errors"
	"strings"

	"gopkg.in/yaml.v3"

	"github.com/yukino-js/yukino/yukino/internal/frontmatter"
)

type ParsedFrontmatter struct {
	Name        string
	Description string
	Type        string
	Body        string
}

// ParseFrontmatter parses YAML frontmatter delimited by `---` lines and
// extracts name/description/type. The type field is read from the top level
// first; the nested metadata.type form is also accepted. Content without a
// leading `---` is returned as body only; a leading `---` without a closing
// delimiter is an error.
func ParseFrontmatter(content string) (ParsedFrontmatter, error) {
	if !strings.HasPrefix(content, "---") {
		return ParsedFrontmatter{Body: content}, nil
	}
	fm, body, ok := frontmatter.Split(content)
	if !ok {
		return ParsedFrontmatter{}, errors.New("Memory frontmatter is missing its closing delimiter")
	}
	var raw any
	if fm != "" {
		if err := yaml.Unmarshal([]byte(fm), &raw); err != nil {
			return ParsedFrontmatter{}, err
		}
	}
	parsed := ParsedFrontmatter{Body: body}
	fields, ok := raw.(map[string]any)
	if !ok {
		if raw != nil {
			return ParsedFrontmatter{}, errors.New("Memory frontmatter must be a mapping")
		}
		return parsed, nil
	}
	if value, ok := fields["name"].(string); ok {
		parsed.Name = value
	}
	if value, ok := fields["description"].(string); ok {
		parsed.Description = value
	}
	if value, ok := fields["type"].(string); ok {
		parsed.Type = value
	}
	if metadata, ok := fields["metadata"].(map[string]any); ok {
		if parsed.Type == "" {
			if value, ok := metadata["type"].(string); ok {
				parsed.Type = value
			}
		}
	}
	return parsed, nil
}

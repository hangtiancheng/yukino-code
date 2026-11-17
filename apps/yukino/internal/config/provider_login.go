package config

import (
	"bytes"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"

	"github.com/google/uuid"
	"gopkg.in/yaml.v3"

	"github.com/yukino-js/yukino/yukino/internal/storage"
)

var digitsOnly = regexp.MustCompile(`^\d+$`)

// tokenLimit mirrors the login schema's numeric preprocessing: unset or blank
// strings fall back to the default; whole-number strings are accepted; the
// result must be an integer within [min, max].
func tokenLimit(value any, fallback, min, max int) (int, error) {
	var number float64
	switch v := value.(type) {
	case nil:
		number = float64(fallback)
	case string:
		trimmed := strings.TrimSpace(v)
		if trimmed == "" {
			number = float64(fallback)
			break
		}
		if !digitsOnly.MatchString(trimmed) {
			return 0, fmt.Errorf("Enter a whole number")
		}
		parsed, err := strconv.ParseFloat(trimmed, 64)
		if err != nil {
			return 0, fmt.Errorf("Enter a whole number")
		}
		number = parsed
	default:
		n, err := asNumber(v)
		if err != nil {
			return 0, fmt.Errorf("Enter a whole number")
		}
		number = n
	}
	if number != float64(int64(number)) {
		return 0, fmt.Errorf("Expected integer, received float")
	}
	if number < float64(min) {
		return 0, fmt.Errorf("Number must be greater than or equal to %d", min)
	}
	if number > float64(max) {
		return 0, fmt.Errorf("Number must be less than or equal to %d", max)
	}
	return int(number), nil
}

// LoginValidationError reports login-form validation failures: Fields maps a
// field key to its message and Form joins them in schema order.
type LoginValidationError struct {
	Fields map[string]string
	Form   string
}

var loginFieldOrder = []string{"name", "protocol", "base_url", "api_key", "model", "thinking", "context_window", "max_output_tokens"}

func (e *LoginValidationError) Error() string {
	if len(e.Fields) == 0 {
		return e.Form
	}
	messages := make([]string, 0, len(e.Fields))
	for _, key := range loginFieldOrder {
		if message, ok := e.Fields[key]; ok {
			messages = append(messages, message)
		}
	}
	return strings.Join(messages, "; ")
}

// ParseProviderLogin validates login-form input, fills optional defaults, and
// persists an explicit effective thinking level while retaining all capability
// metadata.
func ParseProviderLogin(input map[string]any) (ProviderConfig, error) {
	p, err := parseProviderConfig(input)
	if err != nil {
		return p, err
	}
	fields := map[string]string{}
	if strings.TrimSpace(p.Name) == "" {
		fields["name"] = "Name is required"
	}
	parsedURL, urlErr := url.Parse(strings.TrimSpace(p.BaseURL))
	if urlErr != nil || parsedURL.Host == "" {
		fields["base_url"] = "Enter a valid HTTP(S) URL"
	} else if parsedURL.Scheme != "http" && parsedURL.Scheme != "https" {
		fields["base_url"] = "Use an HTTP(S) URL"
	}
	if strings.TrimSpace(p.APIKey) == "" {
		fields["api_key"] = "API key is required"
	}
	if strings.TrimSpace(p.Model) == "" {
		fields["model"] = "Model is required"
	}
	contextWindow, cwErr := tokenLimit(input["context_window"], DefaultContextWindow, 1_000, 10_000_000)
	if cwErr != nil {
		fields["context_window"] = cwErr.Error()
	}
	maxOutputTokens, motErr := tokenLimit(input["max_output_tokens"], DefaultMaxOutputTokens, 1, 1_000_000)
	if motErr != nil {
		fields["max_output_tokens"] = motErr.Error()
	} else if cwErr == nil && maxOutputTokens > contextWindow {
		fields["max_output_tokens"] = "Max output tokens must not exceed the context window"
	}
	if len(fields) > 0 {
		return p, &LoginValidationError{Fields: fields, Form: (&LoginValidationError{Fields: fields}).Error()}
	}
	p.ContextWindow = float64(contextWindow)
	p.MaxOutputTokens = float64(maxOutputTokens)
	p.Thinking = GetThinkingLevel(&p)
	return p, nil
}

// emptyMapping returns an empty ordered mapping node.
func emptyMapping() *yaml.Node {
	return &yaml.Node{Kind: yaml.MappingNode, Tag: "!!map"}
}

// valueNode encodes a plain Go value as a YAML node. The config writers only
// ever pass strings, numbers, booleans, and nil, which encode cleanly.
func valueNode(value any) *yaml.Node {
	node := &yaml.Node{}
	_ = node.Encode(value)
	return node
}

// sequenceNode wraps entry nodes into a YAML sequence.
func sequenceNode(entries []*yaml.Node) *yaml.Node {
	seq := &yaml.Node{Kind: yaml.SequenceNode, Tag: "!!seq"}
	seq.Content = append(seq.Content, entries...)
	return seq
}

// readConfigRaw reads the raw global config as an ordered mapping node; an
// absent file yields an empty one.
func readConfigRaw(path string) (*yaml.Node, error) {
	if _, err := os.Stat(path); err != nil {
		if os.IsNotExist(err) {
			return emptyMapping(), nil
		}
		return nil, err
	}
	data, err := storage.ReadPrivateFileSync(path)
	if err != nil {
		return nil, err
	}
	var root yaml.Node
	if err := yaml.Unmarshal(data, &root); err != nil {
		return nil, fmt.Errorf("Unable to read existing %s; it has not been changed.", path)
	}
	node := &root
	if node.Kind == yaml.DocumentNode && len(node.Content) == 1 {
		node = node.Content[0]
	}
	if node.Kind == 0 || (node.Kind == yaml.ScalarNode && node.Tag == "!!null") {
		return emptyMapping(), nil
	}
	if node.Kind != yaml.MappingNode {
		return nil, fmt.Errorf("Unable to read existing %s; it has not been changed.", path)
	}
	return resolvedNode(node), nil
}

// resolvedNode returns a deep copy of node with aliases replaced by their
// targets and merge keys (<<) expanded in place, matching the fully resolved
// view the plain-value decoder presents. Explicit keys win over merged ones;
// earlier merges win over later ones.
func resolvedNode(node *yaml.Node) *yaml.Node {
	switch node.Kind {
	case yaml.AliasNode:
		if node.Alias == nil {
			return &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!null"}
		}
		return resolvedNode(node.Alias)
	case yaml.MappingNode:
		out := copyNodeShell(node)
		index := map[string]int{}
		place := func(key, value *yaml.Node) {
			if key.Kind != yaml.ScalarNode {
				out.Content = append(out.Content, key, value)
				return
			}
			if pos, ok := index[key.Value]; ok {
				out.Content[pos] = value
				return
			}
			index[key.Value] = len(out.Content) + 1
			out.Content = append(out.Content, key, value)
		}
		for i := 0; i+1 < len(node.Content); i += 2 {
			key, value := node.Content[i], node.Content[i+1]
			if key.Kind == yaml.ScalarNode && key.Value == "<<" {
				for _, source := range mergeSources(value) {
					expanded := resolvedNode(source)
					for j := 0; j+1 < len(expanded.Content); j += 2 {
						merged := expanded.Content[j]
						if merged.Kind == yaml.ScalarNode {
							if _, ok := index[merged.Value]; ok {
								continue
							}
						}
						place(merged, expanded.Content[j+1])
					}
				}
				continue
			}
			place(resolvedNode(key), resolvedNode(value))
		}
		return out
	case yaml.SequenceNode:
		out := copyNodeShell(node)
		for _, item := range node.Content {
			out.Content = append(out.Content, resolvedNode(item))
		}
		return out
	default:
		out := *node
		return &out
	}
}

// copyNodeShell returns an empty container node preserving the presentation
// metadata of node.
func copyNodeShell(node *yaml.Node) *yaml.Node {
	return &yaml.Node{
		Kind:        node.Kind,
		Tag:         node.Tag,
		Style:       node.Style,
		HeadComment: node.HeadComment,
		LineComment: node.LineComment,
		FootComment: node.FootComment,
	}
}

// mergeSources returns the mappings referenced by a merge-key value, which
// may be a single mapping (possibly aliased) or a sequence of them.
func mergeSources(value *yaml.Node) []*yaml.Node {
	if value.Kind == yaml.AliasNode && value.Alias != nil {
		value = value.Alias
	}
	if value.Kind == yaml.SequenceNode {
		sources := make([]*yaml.Node, 0, len(value.Content))
		for _, item := range value.Content {
			if item.Kind == yaml.AliasNode && item.Alias != nil {
				item = item.Alias
			}
			if item.Kind == yaml.MappingNode {
				sources = append(sources, item)
			}
		}
		return sources
	}
	if value.Kind == yaml.MappingNode {
		return []*yaml.Node{value}
	}
	return nil
}

// writeConfigAtomic atomically writes the global config with 0600 permissions.
func writeConfigAtomic(path string, raw *yaml.Node) error {
	directory := filepath.Dir(path)
	if err := storage.MkdirPrivateSync(directory); err != nil {
		return err
	}
	var buffer bytes.Buffer
	encoder := yaml.NewEncoder(&buffer)
	encoder.SetIndent(2)
	err := encoder.Encode(raw)
	if closeErr := encoder.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	temporary := filepath.Join(directory, ".config-"+uuid.NewString()+".tmp")
	if err := storage.WritePrivateFileSync(temporary, buffer.Bytes(), os.O_WRONLY|os.O_CREATE|os.O_TRUNC|os.O_EXCL); err != nil {
		os.Remove(temporary)
		return err
	}
	if err := os.Rename(temporary, path); err != nil {
		os.Remove(temporary)
		return err
	}
	return nil
}

// rawNode returns the value node stored under key, or nil when absent.
func rawNode(raw *yaml.Node, key string) *yaml.Node {
	for i := 0; i+1 < len(raw.Content); i += 2 {
		if raw.Content[i].Value == key {
			return raw.Content[i+1]
		}
	}
	return nil
}

// rawGet decodes the value stored under key; ok is false when absent.
func rawGet(raw *yaml.Node, key string) (any, bool) {
	node := rawNode(raw, key)
	if node == nil {
		return nil, false
	}
	var value any
	if err := node.Decode(&value); err != nil {
		return nil, true
	}
	return value, true
}

// rawSet replaces the value stored under key, appending the key when absent.
// Entries are nodes inside the parsed tree, so the mutation happens in place.
func rawSet(raw *yaml.Node, key string, value any) *yaml.Node {
	return rawSetNode(raw, key, valueNode(value))
}

// rawSetNode replaces the value node stored under key, appending the key when
// absent.
func rawSetNode(raw *yaml.Node, key string, value *yaml.Node) *yaml.Node {
	if existing := rawNode(raw, key); existing != nil {
		*existing = *value
		return raw
	}
	raw.Content = append(raw.Content, &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: key}, value)
	return raw
}

func rawProviders(raw *yaml.Node) ([]*yaml.Node, error) {
	node := rawNode(raw, "providers")
	if node == nil || (node.Kind == yaml.ScalarNode && node.Tag == "!!null") {
		return nil, nil
	}
	if node.Kind != yaml.SequenceNode {
		return nil, fmt.Errorf("providers: expected a list")
	}
	entries := make([]*yaml.Node, 0, len(node.Content))
	for _, item := range node.Content {
		if item.Kind != yaml.MappingNode {
			return nil, fmt.Errorf("providers: expected mapping entries")
		}
		entries = append(entries, item)
	}
	return entries, nil
}

func providerToRecord(p ProviderConfig) *yaml.Node {
	rec := emptyMapping()
	addNode := func(key string, value *yaml.Node) {
		rec.Content = append(rec.Content, &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: key}, value)
	}
	add := func(key string, value any) {
		addNode(key, valueNode(value))
	}
	add("name", p.Name)
	add("protocol", p.Protocol)
	add("base_url", p.BaseURL)
	add("model", p.Model)
	if p.APIKey != "" {
		add("api_key", p.APIKey)
	}
	if p.Thinking != "" {
		add("thinking", p.Thinking)
	}
	if p.Reasoning != nil {
		add("reasoning", *p.Reasoning)
	}
	if p.ThinkingLevelMap != nil {
		levelMap := emptyMapping()
		for _, level := range ThinkingLevels {
			override, ok := p.ThinkingLevelMap[level]
			if !ok {
				continue
			}
			value := &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!null", Value: "null"}
			if !override.Null {
				value = &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: override.Effort}
			}
			levelMap.Content = append(levelMap.Content, &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: level}, value)
		}
		addNode("thinking_level_map", levelMap)
	}
	if p.ThinkingMode != "" {
		add("thinking_mode", p.ThinkingMode)
	}
	if p.ContextWindow != 0 {
		add("context_window", int(p.ContextWindow))
	}
	if p.MaxOutputTokens != 0 {
		add("max_output_tokens", int(p.MaxOutputTokens))
	}
	for _, extra := range p.Extra {
		add(extra.Key, extra.Value)
	}
	return rec
}

type SaveProviderResult struct {
	Provider  ProviderConfig
	Providers []ProviderConfig
	// Whether an existing entry with the same base_url was replaced.
	Replaced bool
	Path     string
}

// SaveProvider saves a provider to the single global config
// ($HOME/.yukino/config.yaml), retaining every currently available provider.
// base_url is the provider identity: an entry with the same base_url is
// replaced in place instead of appended, and names may repeat freely.
func SaveProvider(input map[string]any, available []ProviderConfig) (SaveProviderResult, error) {
	provider, err := ParseProviderLogin(input)
	if err != nil {
		return SaveProviderResult{}, err
	}
	path := GlobalConfigPath()
	raw, err := readConfigRaw(path)
	if err != nil {
		return SaveProviderResult{}, err
	}
	existing, err := rawProviders(raw)
	if err != nil {
		return SaveProviderResult{}, err
	}
	// Retain every currently available provider so an in-memory list never
	// loses entries that are not yet written to the file.
	current := append([]*yaml.Node{}, existing...)
	for _, entry := range available {
		found := false
		for _, stored := range current {
			if v, _ := rawGet(stored, "base_url"); v == entry.BaseURL {
				found = true
				break
			}
		}
		if !found {
			current = append(current, providerToRecord(entry))
		}
	}
	var storedEntries []*yaml.Node
	replaced := false
	for _, entry := range current {
		baseURL, _ := rawGet(entry, "base_url")
		if baseURL != provider.BaseURL {
			storedEntries = append(storedEntries, entry)
			continue
		}
		// Replace the first match in place and drop any further duplicates, so
		// one endpoint keeps exactly one entry.
		if replaced {
			continue
		}
		replaced = true
		storedEntries = append(storedEntries, providerToRecord(provider))
	}
	if !replaced {
		storedEntries = append(storedEntries, providerToRecord(provider))
	}
	providers := make([]ProviderConfig, 0, len(storedEntries))
	for _, entry := range storedEntries {
		var rec map[string]any
		if err := entry.Decode(&rec); err != nil {
			return SaveProviderResult{}, err
		}
		p, err := parseProviderConfig(rec)
		if err != nil {
			return SaveProviderResult{}, err
		}
		providers = append(providers, p)
	}
	raw = rawSetNode(raw, "providers", sequenceNode(storedEntries))
	if err := writeConfigAtomic(path, raw); err != nil {
		return SaveProviderResult{}, err
	}
	return SaveProviderResult{Provider: provider, Providers: providers, Replaced: replaced, Path: path}, nil
}

// persistProviderField persists a single field of every provider entry
// matching base_url. The endpoint is the provider identity, so all entries for
// it change together. It errors when the endpoint is absent so callers can
// surface a clear message.
func persistProviderField(baseURL, field, value string) error {
	path := GlobalConfigPath()
	raw, err := readConfigRaw(path)
	if err != nil {
		return err
	}
	providers, err := rawProviders(raw)
	if err != nil {
		return err
	}
	targets := 0
	changed := false
	for _, entry := range providers {
		if v, _ := rawGet(entry, "base_url"); v != baseURL {
			continue
		}
		targets++
		if current, _ := rawGet(entry, field); current != value {
			rawSet(entry, field, value)
			changed = true
		}
	}
	if targets == 0 {
		return fmt.Errorf("Provider with base URL %q not found in %s.", baseURL, path)
	}
	// Avoid rewriting (and reformatting) the file when nothing changes.
	if !changed {
		return nil
	}
	return writeConfigAtomic(path, raw)
}

func PersistThinkingLevel(baseURL, level string) error {
	return persistProviderField(baseURL, "thinking", level)
}

// PersistModel persists the active model of a provider without touching any
// other field.
func PersistModel(baseURL, model string) error {
	return persistProviderField(baseURL, "model", model)
}

// PersistDefaultProvider persists the index of the provider the user selected
// last, so the next start selects it directly instead of showing the provider
// picker. No-op when the stored index already matches, so the file is not
// rewritten (and reformatted) on every selection.
func PersistDefaultProvider(index int) error {
	path := GlobalConfigPath()
	raw, err := readConfigRaw(path)
	if err != nil {
		return err
	}
	if current, ok := rawGet(raw, "default_provider"); ok {
		if n, err := asNumber(current); err == nil && int(n) == index {
			return nil
		}
	}
	raw = rawSet(raw, "default_provider", index)
	return writeConfigAtomic(path, raw)
}

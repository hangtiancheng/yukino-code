package workflow

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strings"
	"sync"

	"github.com/santhosh-tekuri/jsonschema/v6"
)

type cachedValidator struct {
	schema *jsonschema.Schema
	err    error
}

var (
	validatorCacheMu sync.Mutex
	validatorCache   = map[string]*cachedValidator{}
)

func getValidator(schema map[string]any) (*jsonschema.Schema, error) {
	encoded, err := json.Marshal(schema)
	if err != nil {
		return nil, err
	}
	key := string(encoded)
	validatorCacheMu.Lock()
	defer validatorCacheMu.Unlock()
	if cached, ok := validatorCache[key]; ok {
		return cached.schema, cached.err
	}
	compiler := jsonschema.NewCompiler()
	compiled, err := func() (*jsonschema.Schema, error) {
		doc, err := jsonschema.UnmarshalJSON(bytes.NewReader(encoded))
		if err != nil {
			return nil, err
		}
		if err := compiler.AddResource("schema.json", doc); err != nil {
			return nil, err
		}
		return compiler.Compile("schema.json")
	}()
	if err == nil {
		if async, ok := schema["$async"].(bool); ok && async {
			err = fmt.Errorf("Async JSON schemas are not supported")
			compiled = nil
		}
	}
	validatorCache[key] = &cachedValidator{schema: compiled, err: err}
	return compiled, err
}

// AssertValidJsonSchema compiles the schema, mirroring assertValidJsonSchema.
func AssertValidJsonSchema(schema map[string]any) error {
	_, err := getValidator(schema)
	return err
}

// ValidateAgainstSchema validates a value against a compiled schema,
// mirroring validateAgainstSchema (error strings follow the ajv
// "instancePath message" shape as closely as the Go validator allows).
func ValidateAgainstSchema(value any, schema map[string]any) (bool, []string) {
	validator, err := getValidator(schema)
	if err != nil {
		return false, []string{err.Error()}
	}
	if err := validator.Validate(value); err != nil {
		var messages []string
		collectValidationErrors(err, &messages)
		if len(messages) == 0 {
			messages = []string{"validation error"}
		}
		return false, messages
	}
	return true, nil
}

func collectValidationErrors(err error, messages *[]string) {
	validationErr, ok := err.(*jsonschema.ValidationError)
	if !ok {
		*messages = append(*messages, err.Error())
		return
	}
	if len(validationErr.Causes) == 0 {
		message := strings.TrimSpace(validationErr.Error())
		location := ""
		if len(validationErr.InstanceLocation) > 0 {
			location = "/" + strings.Join(validationErr.InstanceLocation, "/")
		}
		if location != "" && !strings.Contains(message, location) {
			message = location + " " + message
		}
		*messages = append(*messages, message)
		return
	}
	for _, cause := range validationErr.Causes {
		collectValidationErrors(cause, messages)
	}
}

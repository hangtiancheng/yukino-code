package workflow

import (
	"fmt"
	"regexp"
	"strings"

	"github.com/dop251/goja"
)

// ScriptError marks workflow script compilation and meta errors.
type ScriptError struct{ Message string }

func (e *ScriptError) Error() string { return e.Message }

var metaRe = regexp.MustCompile(`export\s+const\s+meta\s*=\s*`)

var (
	importStmtRe    = regexp.MustCompile(`(?m)^\s*import\b`)
	dynamicImportRe = regexp.MustCompile(`(?m)\bimport\s*\(`)
	exportStmtRe    = regexp.MustCompile(`(?m)^\s*export\b`)
	leadingSemiRe   = regexp.MustCompile(`^[ \t]*;[ \t]*\n`)
)

func isScriptSpace(c byte) bool {
	switch c {
	case ' ', '\t', '\n', '\r', '\v', '\f':
		return true
	}
	return false
}

// sandboxPrelude builds the Date/Math proxies inside the VM, mirroring
// sandboxDate()/sandboxMath() (Proxy semantics, identical error messages),
// plus the parallel/pipeline composition primitives. The reference
// implements those two host-side (hooks.ts); running them as VM prelude JS
// keeps the native Promise.all semantics identical while the caps, warn
// routing and abort classification stay verbatim.
const sandboxPrelude = `class NonDeterministicError extends Error {
  constructor(fn) {
    super(fn + " is not available in workflow scripts (would break resume determinism). Pass timestamps/random seeds via args.");
    this.name = "NonDeterministicError";
  }
}
const Date = new Proxy(RealDate, {
  apply() { throw new NonDeterministicError("Date()"); },
  construct(target, ctorArgs, newTarget) {
    if (ctorArgs.length === 0) { throw new NonDeterministicError("new Date()"); }
    const result = Reflect.construct(target, ctorArgs, newTarget);
    if (!(result instanceof RealDate)) { throw new Error("Invalid Date result"); }
    return result;
  },
  get(target, property, receiver) {
    if (property === "now") { return () => { throw new NonDeterministicError("Date.now()"); }; }
    return Reflect.get(target, property, receiver);
  }
});
const Math = new Proxy(RealMath, {
  get(target, property, receiver) {
    if (property === "random") { return () => { throw new NonDeterministicError("Math.random()"); }; }
    return Reflect.get(target, property, receiver);
  }
});
const __MAX_ITEMS_PER_CALL = 4096;
function __capError(kind) {
  const error = new Error(kind + " exceeds the per-call items cap (" + __MAX_ITEMS_PER_CALL + ")");
  error.name = "WorkflowError";
  return error;
}
async function parallel(thunks) {
  if (thunks.length > __MAX_ITEMS_PER_CALL) { throw __capError("parallel"); }
  return Promise.all(thunks.map(async (thunk) => {
    try {
      return await thunk();
    } catch (error) {
      if (error && error.name === "WorkflowAbortedError") { throw error; }
      __warn(error instanceof Error ? error.message : String(error));
      return null;
    }
  }));
}
async function pipeline(items, ...stages) {
  if (items.length > __MAX_ITEMS_PER_CALL) { throw __capError("pipeline"); }
  return parallel(items.map((item, index) => async () => {
    let previous = item;
    for (const stage of stages) {
      previous = await stage(previous, item, index);
    }
    return previous;
  }));
}
`

// ExtractMeta pulls the `export const meta = {...}` literal out of the
// source, evaluating it in vm like the reference does.
func ExtractMeta(vm *goja.Runtime, source string) (*WorkflowMeta, string, error) {
	match := metaRe.FindStringIndex(source)
	if match == nil {
		return nil, source, nil
	}
	i := match[1]
	for i < len(source) && isScriptSpace(source[i]) {
		i++
	}
	if i >= len(source) || source[i] != '{' {
		return nil, "", &ScriptError{Message: "meta must be an object literal `{ ... }`"}
	}
	depth := 0
	start := i
	var inStr byte
	closed := false
	for ; i < len(source); i++ {
		ch := source[i]
		if inStr != 0 {
			if ch == '\\' {
				i++
				continue
			}
			if ch == inStr {
				inStr = 0
			}
			continue
		}
		switch ch {
		case '"', '\'', '`':
			inStr = ch
		case '{':
			depth++
		case '}':
			depth--
			if depth == 0 {
				i++
				closed = true
			}
		}
		if closed {
			break
		}
	}
	if depth != 0 {
		return nil, "", &ScriptError{Message: "meta literal braces are not closed"}
	}
	literal := source[start:i]
	value, err := vm.RunString("(" + literal + ")")
	if err != nil {
		return nil, "", &ScriptError{Message: fmt.Sprintf("meta must be a plain literal (no variable/function calls/interpolation): %s", ErrorString(err))}
	}
	meta, err := ValidateMeta(value)
	if err != nil {
		return nil, "", err
	}
	rest := leadingSemiRe.ReplaceAllString(source[i:], "\n")
	body := source[:match[0]] + rest
	return meta, body, nil
}

// ValidateMeta checks the evaluated meta literal against workflowMetaSchema.
func ValidateMeta(value goja.Value) (*WorkflowMeta, error) {
	exported := value.Export()
	obj, ok := exported.(map[string]any)
	if !ok {
		return nil, &ScriptError{Message: "meta must include string name and description and valid phases"}
	}
	meta := &WorkflowMeta{}
	name, ok := obj["name"].(string)
	if !ok {
		return nil, &ScriptError{Message: "meta must include string name and description and valid phases"}
	}
	meta.Name = name
	description, ok := obj["description"].(string)
	if !ok {
		return nil, &ScriptError{Message: "meta must include string name and description and valid phases"}
	}
	meta.Description = description
	if value, ok := obj["whenToUse"]; ok && value != nil {
		text, ok := value.(string)
		if !ok {
			return nil, &ScriptError{Message: "meta must include string name and description and valid phases"}
		}
		meta.WhenToUse = text
	}
	if value, ok := obj["phases"]; ok && value != nil {
		list, ok := value.([]any)
		if !ok {
			return nil, &ScriptError{Message: "meta must include string name and description and valid phases"}
		}
		for _, item := range list {
			phaseObj, ok := item.(map[string]any)
			if !ok {
				return nil, &ScriptError{Message: "meta must include string name and description and valid phases"}
			}
			title, ok := phaseObj["title"].(string)
			if !ok {
				return nil, &ScriptError{Message: "meta must include string name and description and valid phases"}
			}
			phase := WorkflowPhase{Title: title}
			if detail, ok := phaseObj["detail"]; ok && detail != nil {
				text, ok := detail.(string)
				if !ok {
					return nil, &ScriptError{Message: "meta must include string name and description and valid phases"}
				}
				phase.Detail = text
			}
			meta.Phases = append(meta.Phases, phase)
		}
	}
	return meta, nil
}

func assertScriptBody(body string) error {
	if importStmtRe.MatchString(body) {
		return &ScriptError{Message: "workflow scripts are the body of new AsyncFunction (not ESM modules); import is not supported. " +
			"agent / parallel / pipeline / phase / log / workflow / args / budget are injected as parameters — use them directly."}
	}
	if dynamicImportRe.MatchString(body) {
		return &ScriptError{Message: "dynamic import(...) is forbidden in workflow scripts: it bypasses the Date/Math sandbox and breaks resume determinism. " +
			"The sandbox does not guarantee security (same trust level as the LLM), but explicit escapes are prohibited. Inject external dependencies via args."}
	}
	if exportStmtRe.MatchString(body) {
		return &ScriptError{Message: "workflow scripts allow only one export const meta = {...} (already extracted by the engine). " +
			"Remove other export / export default statements; use top-level return for the result."}
	}
	return nil
}

// ParsedScript is a compiled workflow script bound to its own goja runtime.
type ParsedScript struct {
	Meta *WorkflowMeta
	vm   *goja.Runtime
	fn   goja.Callable
}

// VM exposes the script's runtime; all access must happen on the loop
// goroutine that drives the run.
func (p *ParsedScript) VM() *goja.Runtime { return p.vm }

// ParseScript compiles the source into an async function with the injected
// primitives, mirroring parseScript (AsyncFunction body semantics, Date/Math
// sandbox, import/export guards).
func ParseScript(source string) (*ParsedScript, error) {
	vm := goja.New()
	meta, body, err := ExtractMeta(vm, source)
	if err != nil {
		return nil, err
	}
	if err := assertScriptBody(body); err != nil {
		return nil, err
	}
	wrapper := "(async function(agent, phase, log, workflow, args, budget, RealDate, RealMath, __warn) {\n" +
		sandboxPrelude + body + "\n})"
	program, err := goja.Compile("workflow.js", wrapper, false)
	if err != nil {
		return nil, &ScriptError{Message: fmt.Sprintf("Script syntax error: %s", ErrorString(err))}
	}
	value, err := vm.RunProgram(program)
	if err != nil {
		return nil, &ScriptError{Message: fmt.Sprintf("Script syntax error: %s", ErrorString(err))}
	}
	fn, ok := goja.AssertFunction(value)
	if !ok {
		return nil, &ScriptError{Message: "Script syntax error: compiled value is not a function"}
	}
	return &ParsedScript{Meta: meta, vm: vm, fn: fn}, nil
}

// Execute calls the compiled script with the hook values and args. The
// returned value is the script's top-level promise.
func (p *ParsedScript) Execute(hooks *ScriptHookValues, args goja.Value, budget goja.Value) (goja.Value, error) {
	// The real Date/Math are fetched from the VM's globals; the prelude
	// shadows them with sandboxed proxies inside the function body.
	realDate := p.vm.GlobalObject().Get("Date")
	realMath := p.vm.GlobalObject().Get("Math")
	return p.fn(goja.Undefined(),
		hooks.Agent, hooks.Phase, hooks.Log, hooks.Workflow,
		args, budget, realDate, realMath, hooks.Warn)
}

// ScriptHookValues are the goja callables injected into the script.
type ScriptHookValues struct {
	Agent    goja.Value
	Phase    goja.Value
	Log      goja.Value
	Workflow goja.Value
	Warn     goja.Value
}

// ErrorString mirrors asErrorString for goja/JS values and Go errors.
func ErrorString(err error) string {
	if err == nil {
		return ""
	}
	var exception *goja.Exception
	if asException(err, &exception) {
		value := exception.Value()
		if obj, ok := value.(*goja.Object); ok {
			if message := obj.Get("message"); message != nil && !goja.IsUndefined(message) {
				return message.String()
			}
		}
		return exception.String()
	}
	return err.Error()
}

func asException(err error, target **goja.Exception) bool {
	if exception, ok := err.(*goja.Exception); ok {
		*target = exception
		return true
	}
	return false
}

// ExportErrorMessage extracts the message from a rejected promise result.
func ExportErrorMessage(value goja.Value) string {
	if value == nil {
		return "unknown error"
	}
	if obj, ok := value.(*goja.Object); ok {
		if message := obj.Get("message"); message != nil && !goja.IsUndefined(message) && !goja.IsNull(message) {
			return message.String()
		}
	}
	text := strings.TrimSpace(value.String())
	if text == "" {
		return "unknown error"
	}
	return text
}

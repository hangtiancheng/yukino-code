package hooks

import (
	"errors"

	"github.com/dop251/goja"
)

// Hook conditions are JavaScript expressions. The reference compiles them with
// new Function and evaluates against the hook context; goja provides the same
// semantics. The config file already grants arbitrary shell execution through
// command actions, so evaluating expressions from the same source adds no new
// privilege.
func compileCondition(condition string) (*goja.Program, error) {
	return goja.Compile(
		"hook-condition.js",
		`(function (event, tool, filePath, message, args) { "use strict"; return (`+condition+`); })`,
		false,
	)
}

func evaluateCondition(condition string, ctx HookContext) (bool, error) {
	program, err := compileCondition(condition)
	if err != nil {
		return false, err
	}
	vm := goja.New()
	value, err := vm.RunProgram(program)
	if err != nil {
		return false, err
	}
	fn, ok := goja.AssertFunction(value)
	if !ok {
		return false, errors.New("hook condition did not compile to a function")
	}
	args := ctx.Args
	if args == nil {
		args = map[string]any{}
	}
	result, err := fn(
		goja.Undefined(),
		vm.ToValue(string(ctx.Event)),
		vm.ToValue(ctx.ToolName),
		vm.ToValue(ctx.FilePath),
		vm.ToValue(ctx.Message),
		vm.ToValue(args),
	)
	if err != nil {
		return false, err
	}
	return result.ToBoolean(), nil
}

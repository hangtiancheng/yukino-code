package main

import (
	"context"
	"fmt"
	"os"
	"strings"

	"github.com/yukino-js/yukino/yukino/internal/update"
)

// updateUsage mirrors UPDATE_USAGE in src/cli.ts.
const updateUsage = "Usage: yukino update [--tag <tag>]"

// updateHelp mirrors UPDATE_HELP in src/cli.ts.
const updateHelp = updateUsage + `

Update Yukino from an npm dist-tag.

Options:
  --tag <tag>  npm dist-tag to check (default: latest)
  -h, --help   Show this help

Examples:
  yukino update
  yukino update --tag=canary`

// parseUpdateArgs mirrors parseUpdateArgs in src/cli.ts. A nil tag with no
// error means no --tag was given (the default dist-tag applies); an explicit
// --tag= yields a non-nil pointer, including the empty value.
func parseUpdateArgs(args []string) (tag *string, help bool, err error) {
	for i := 0; i < len(args); i++ {
		token := args[i]
		if token == "--help" || token == "-h" {
			return nil, true, nil
		}
		if token == "--tag" {
			if i+1 >= len(args) || strings.HasPrefix(args[i+1], "-") {
				return nil, false, fmt.Errorf("Option '--tag' requires a value.\n%s", updateUsage)
			}
			value := args[i+1]
			tag = &value
			i++
			continue
		}
		if strings.HasPrefix(token, "--tag=") {
			value := strings.TrimPrefix(token, "--tag=")
			tag = &value
			continue
		}
		problem := fmt.Sprintf("Unexpected argument '%s'.", token)
		if strings.HasPrefix(token, "-") {
			problem = fmt.Sprintf("Unknown option '%s'.", token)
		}
		return nil, false, fmt.Errorf("%s\n%s", problem, updateUsage)
	}
	return tag, false, nil
}

// runUpdateMode mirrors the CLI "update" branch: a maintenance mode that runs
// without loading the runtime or configuration. It returns the process exit
// code.
func runUpdateMode(args []string) int {
	tag, help, err := parseUpdateArgs(args)
	if help {
		fmt.Println(updateHelp)
		return 0
	}
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %s\n", err)
		return 1
	}
	return update.RunUpdate(context.Background(), tag)
}

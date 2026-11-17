package main

import (
	"fmt"
	"strings"
)

const cliHelp = `Yukino is a terminal-based AI coding agent.

Usage: yukino [options]

Options:
  -h, --help                  Show this help
  -v, --version               Show the version number
  -p <prompt>                 Run a single prompt non-interactively and print the result
      --output-format <fmt>   Output format for -p: text (default) or stream-json
      --resume [session-id]   Resume a previous session; opens a picker when omitted
      --remote [addr]         Start the remote server (default: 127.0.0.1:18888)
      --a2a [addr]            Start an A2A server (default: 127.0.0.1:18890)

Commands:
  update [--tag <tag>]        Update Yukino from an npm dist-tag (default: latest)

With no options, Yukino starts an interactive terminal session.
Type /help inside a session to list the available slash commands.

Examples:
  yukino
  yukino -p "explain this codebase"
  yukino -p "fix the failing test" --output-format stream-json
  yukino --resume
  yukino --remote 9000`

const printPromptRequired = "-p requires a prompt argument immediately after it; use '-p -- <prompt>' when the prompt starts with '-'"
const cliHelpHint = "Run 'yukino --help' for usage."

type cliMode struct {
	Kind         string  `json:"kind"`
	Topic        string  `json:"topic,omitempty"`
	Tag          *string `json:"tag,omitempty"`
	Prompt       string  `json:"prompt,omitempty"`
	OutputFormat string  `json:"outputFormat,omitempty"`
	Address      *string `json:"address,omitempty"`
	Resume       any     `json:"resume,omitempty"`
}

func parseCliArgs(argv []string) (cliMode, error) {
	if len(argv) > 0 && argv[0] == "update" {
		tag, help, err := parseUpdateArgs(argv[1:])
		if help {
			return cliMode{Kind: "help", Topic: "update"}, nil
		}
		return cliMode{Kind: "update", Tag: tag}, err
	}
	var server, prompt, outputFormat string
	var address *string
	var resume any
	promptSet, endOfOptions := false, false
	takenOption := func() string {
		if server != "" {
			return "--" + server
		}
		if promptSet {
			return "-p"
		}
		if resume != nil {
			return "--resume"
		}
		if outputFormat != "" {
			return "--output-format"
		}
		return ""
	}
	setResume := func(value any) error {
		if server != "" {
			return fmt.Errorf("--resume cannot be combined with --%s.", server)
		}
		if promptSet {
			return fmt.Errorf("--resume cannot be combined with -p.")
		}
		resume = value
		return nil
	}
	for i := 0; i < len(argv); i++ {
		token := argv[i]
		if endOfOptions {
			return cliMode{}, fmt.Errorf("Unexpected argument \"%s\". %s", token, cliHelpHint)
		}
		switch token {
		case "--":
			endOfOptions = true
		case "--help", "-h":
			return cliMode{Kind: "help"}, nil
		case "--version", "-v":
			return cliMode{Kind: "version"}, nil
		case "-p":
			if server != "" {
				return cliMode{}, fmt.Errorf("-p cannot be combined with --%s.", server)
			}
			if promptSet {
				return cliMode{}, fmt.Errorf("Option '-p' was already specified.")
			}
			if resume != nil {
				return cliMode{}, fmt.Errorf("-p cannot be combined with --resume.")
			}
			i++
			if i < len(argv) && argv[i] == "--" {
				endOfOptions = true
				i++
			}
			if i >= len(argv) || strings.TrimSpace(argv[i]) == "" || (!endOfOptions && strings.HasPrefix(argv[i], "-")) {
				return cliMode{}, fmt.Errorf("%s", printPromptRequired)
			}
			prompt, promptSet = argv[i], true
		case "--output-format":
			if server != "" {
				return cliMode{}, fmt.Errorf("--output-format cannot be combined with --%s.", server)
			}
			i++
			value := "nothing"
			if i < len(argv) {
				value = argv[i]
			}
			if value != "text" && value != "stream-json" {
				return cliMode{}, fmt.Errorf("--output-format requires 'text' or 'stream-json' (got '%s')", value)
			}
			outputFormat = value
		case "--resume":
			var value any = true
			if i+1 < len(argv) && !strings.HasPrefix(argv[i+1], "-") {
				i++
				value = argv[i]
			}
			if err := setResume(value); err != nil {
				return cliMode{}, err
			}
		case "--remote", "--a2a":
			taken := takenOption()
			if taken == token {
				return cliMode{}, fmt.Errorf("Option '%s' was already specified.", token)
			}
			if taken != "" {
				return cliMode{}, fmt.Errorf("%s cannot be combined with %s.", token, taken)
			}
			server = strings.TrimPrefix(token, "--")
			if i+1 < len(argv) && !strings.HasPrefix(argv[i+1], "-") {
				i++
				value := argv[i]
				address = &value
			} else if server == "remote" {
				value := "18888"
				address = &value
			}
		default:
			if strings.HasPrefix(token, "--resume=") {
				var value any = strings.TrimPrefix(token, "--resume=")
				if value == "" {
					value = true
				}
				if err := setResume(value); err != nil {
					return cliMode{}, err
				}
				continue
			}
			problem := "Unexpected argument"
			if strings.HasPrefix(token, "-") {
				problem = "Unknown option"
			}
			return cliMode{}, fmt.Errorf("%s \"%s\". %s", problem, token, cliHelpHint)
		}
	}
	if outputFormat != "" && !promptSet {
		return cliMode{}, fmt.Errorf("--output-format requires -p.")
	}
	if promptSet {
		if outputFormat == "" {
			outputFormat = "text"
		}
		return cliMode{Kind: "print", Prompt: prompt, OutputFormat: outputFormat}, nil
	}
	if server != "" {
		return cliMode{Kind: server, Address: address}, nil
	}
	return cliMode{Kind: "ui", Resume: resume}, nil
}

package main

import (
	"context"
	"fmt"
	"os"
	"os/signal"

	"github.com/yukino-js/yukino/yukino/agent"
	"github.com/yukino-js/yukino/yukino/config"
	"github.com/yukino-js/yukino/yukino/conversation"
	"github.com/yukino-js/yukino/yukino/llm"
	"github.com/yukino-js/yukino/yukino/tools"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run() error {
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt)
	defer cancel()
	client, err := llm.NewClient(&config.ProviderConfig{
		Protocol: "openai", Model: os.Getenv("YUKINO_MODEL"),
		APIKey: os.Getenv("OPENAI_API_KEY"), BaseURL: os.Getenv("OPENAI_BASE_URL"),
	}, "You are a helpful assistant.")
	if err != nil {
		return err
	}
	registry := tools.NewRegistry()
	defer registry.Dispose()
	runner := agent.New(client, registry, "openai")
	runner.MaxIterations = 8
	conv := conversation.NewManager()
	conv.AddUserMessage("Say hello in one sentence.")
	var runErr error
	for event := range runner.Run(ctx, conv) {
		switch event := event.(type) {
		case agent.StreamText:
			fmt.Print(event.Text)
		case agent.ErrorEvent:
			runErr = fmt.Errorf("agent: %s", event.Message)
		}
	}
	fmt.Println()
	if ctx.Err() != nil {
		return ctx.Err()
	}
	return runErr
}

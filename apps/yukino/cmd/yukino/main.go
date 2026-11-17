package main

import (
	"fmt"
	"os"
	"os/signal"
	"runtime/debug"
	"syscall"
	"time"

	tea "github.com/charmbracelet/bubbletea"

	"github.com/charmbracelet/x/term"
	"github.com/yukino-js/yukino/yukino/internal/a2a"
	"github.com/yukino-js/yukino/yukino/internal/config"
	"github.com/yukino-js/yukino/yukino/internal/crash_log"
	"github.com/yukino-js/yukino/yukino/internal/hooks"
	"github.com/yukino-js/yukino/yukino/internal/logger"
	"github.com/yukino-js/yukino/yukino/internal/remote"
	"github.com/yukino-js/yukino/yukino/internal/session"
	"github.com/yukino-js/yukino/yukino/internal/telemetry"
	"github.com/yukino-js/yukino/yukino/internal/tools"
	"github.com/yukino-js/yukino/yukino/internal/ui"
	"github.com/yukino-js/yukino/yukino/internal/version"
)

// loadRuntimeConfig loads the app config with the project .mcp.json servers
// merged and validates the hook configuration, mirroring the reference mode
// runners.
func loadRuntimeConfig(allowEmptyProviders bool) (*config.AppConfig, []config.HookConfig, error) {
	cfg, err := config.LoadConfig("", config.LoadOptions{AllowEmptyProviders: allowEmptyProviders})
	if err != nil {
		return nil, nil, err
	}
	cwd, err := os.Getwd()
	if err == nil {
		cfg = config.WithProjectMcpServers(cfg, cwd)
	}
	validHooks := cfg.Hooks
	if err := hooks.Validate(validHooks); err != nil {
		fmt.Fprintf(os.Stderr, "Warning: hook configuration is invalid, starting with no hooks:\n%s\n", err)
		validHooks = nil
	}
	return cfg, validHooks, nil
}

// exitNow runs the exit sweeps the reference performs from its process exit
// handler and terminates with the given code.
func exitNow(code int) {
	tools.RunExitCleanups()
	logger.CloseLogger()
	crash_log.RecordExit(code)
	os.Exit(code)
}

func main() {
	mode, err := parseCliArgs(os.Args[1:])
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %s\n", err)
		os.Exit(1)
	}
	switch mode.Kind {
	case "help":
		if mode.Topic == "update" {
			fmt.Println(updateHelp)
		} else {
			fmt.Println(cliHelp)
		}
		return
	case "version":
		fmt.Println(version.Version)
		return
	case "update":
		exitNow(runUpdateMode(os.Args[2:]))
	}
	defer logger.CloseLogger()
	defer tools.RunExitCleanups()
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, syscall.SIGHUP, syscall.SIGTERM)
	defer signal.Stop(signals)
	go func() {
		sig := <-signals
		if sig == syscall.SIGTERM && (telemetry.RemoteSignalHandlersInstalled() || printOwnsSignals.Load()) {
			// Remote/print mode owns SIGINT/SIGTERM shutdown.
			return
		}
		tools.RunExitCleanups()
		logger.CloseLogger()
		os.Exit(1)
	}()

	recordExit := crash_log.Install()
	defer recordExit()
	defer func() {
		if r := recover(); r != nil {
			if err, ok := r.(error); ok && crash_log.IsTerminalGone(err) {
				crash_log.ExitForTerminalGone("uncaught exception", r)
			}
			crash_log.RecordPanic("main", r, debug.Stack())
			logger.Global().Fatal(map[string]any{"err": r}, "uncaught exception")
			telemetry.CaptureTelemetryError(fmt.Errorf("%v", r), "uncaught exception")
			// Sync sweep before the telemetry flush: the process is going down,
			// and detached children must not survive it as orphans.
			tools.RunExitCleanups()
			telemetry.ShutdownTelemetry()
			panic(r)
		}
	}()

	// Fill the process environment from the global config's env block before
	// anything reads it: telemetry initialization reads OTEL_*/SENTRY_* from
	// the environment before the config is loaded.
	config.HydrateConfigEnv()

	telemetry.InitializeTelemetry()

	if mode.Kind == "a2a" {
		a2aAddr := ""
		if mode.Address != nil {
			a2aAddr = *mode.Address
		}
		telemetry.SetTelemetryMode(telemetry.ModeA2A)
		if err := a2a.RunA2aServer(a2aAddr); err != nil {
			telemetry.CaptureTelemetryError(err, "main")
			crash_log.RecordError("main", err)
			logger.Global().Fatal(map[string]any{"err": err}, "unhandled runtime error")
			telemetry.ShutdownTelemetry()
			exitNow(-1)
		}
		telemetry.ShutdownTelemetry()
		return
	}

	if mode.Kind == "print" {
		telemetry.SetTelemetryMode(telemetry.ModePrint)
		cfg, validHooks, err := loadRuntimeConfig(false)
		if err != nil {
			telemetry.CaptureTelemetryError(err, "print")
			fmt.Fprintf(os.Stderr, "Error: %s\n", err)
			telemetry.ShutdownTelemetry()
			exitNow(1)
		}
		exitCode, err := runPrint(mode.Prompt, cfg, validHooks, mode.OutputFormat)
		if err != nil {
			telemetry.CaptureTelemetryError(err, "print")
			fmt.Fprintf(os.Stderr, "Error: %s\n", err)
			telemetry.ShutdownTelemetry()
			exitNow(1)
		}
		telemetry.ShutdownTelemetry()
		if exitCode != 0 {
			exitNow(exitCode)
		}
		return
	}

	if mode.Kind == "remote" {
		cfg, validHooks, err := loadRuntimeConfig(true)
		if err != nil {
			telemetry.CaptureTelemetryError(err, "config")
			fmt.Fprintf(os.Stderr, "Error: %s\n", err)
			telemetry.ShutdownTelemetry()
			exitNow(1)
		}
		telemetry.SetTelemetryMode(telemetry.ModeRemote)
		if err := logger.InitLogger(logger.InitLoggerOptions{SessionID: session.NewID(), Mode: logger.ModeRemote, Stdout: true}); err != nil {
			fmt.Fprintf(os.Stderr, "Error: %s\n", err)
			telemetry.ShutdownTelemetry()
			exitNow(1)
		}
		srv := remote.NewServer(cfg.Providers, cfg.MCPServers, validHooks, *mode.Address, cfg.EnableCoordinatorMode, cfg.DefaultProvider, cfg.Sandbox, cfg.MemoryEnabled())
		srv.MCPLoading = cfg.MCPLoading
		// Graceful shutdown on Ctrl+C/SIGTERM: stop the server (closes WS/HTTP,
		// disconnects MCP children), sweep detached children and persist the
		// real exit code before telemetry flushes.
		telemetry.InstallRemoteTelemetrySignalHandlers(func(exitCode int) {
			srv.Stop()
			tools.RunExitCleanups()
			crash_log.RecordExit(exitCode)
		})
		if err := srv.Run(); err != nil {
			telemetry.CaptureTelemetryError(err, "remote")
			fmt.Fprintf(os.Stderr, "Remote server error: %s\n", err)
			telemetry.ShutdownTelemetry()
			exitNow(1)
		}
		// Run returns nil after Stop. On a signal the handler goroutine
		// flushes telemetry and exits with the signal's code; on a WS-quit
		// stop there is no signal, so fall through and exit cleanly like the
		// reference's runMode tail.
		if telemetry.RemoteSignalFired() {
			select {}
		}
		return
	}

	cfg, validHooks, err := loadRuntimeConfig(true)
	if err != nil {
		telemetry.CaptureTelemetryError(err, "config")
		fmt.Fprintf(os.Stderr, "Error: %s\n", err)
		telemetry.ShutdownTelemetry()
		exitNow(1)
	}
	telemetry.SetTelemetryMode(telemetry.ModeTerminal)
	if err := logger.InitLogger(logger.InitLoggerOptions{SessionID: session.NewID(), Mode: logger.ModeTerminal}); err != nil {
		fmt.Fprintf(os.Stderr, "Error: %s\n", err)
		telemetry.ShutdownTelemetry()
		exitNow(1)
	}
	terminalInput, err := ui.NewTerminalInput(os.Stdin)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %s\n", err)
		telemetry.ShutdownTelemetry()
		exitNow(1)
	}
	defer terminalInput.Close()
	ui.SetThemeMode(ui.DetectTerminalTheme(terminalInput, os.Stdout, cfg.Theme))
	// Reset any mouse tracking a previous program (or a crashed yukino) left
	// enabled, so the terminal does not send mouse escape sequences that
	// bubbletea would misread as key input. bubbletea only disables mouse on
	// exit, and never the X10 (?1000) mode, so do the full reset at startup.
	if term.IsTerminal(os.Stdout.Fd()) {
		fmt.Print("\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l")
	}
	m := ui.New(cfg.Providers, cfg.MCPServers, validHooks, cfg.Sandbox, cfg.DefaultProvider, cfg.PermissionMode, cfg.MemoryEnabled())
	m.EnableCoordinatorMode = cfg.EnableCoordinatorMode
	m.MCPLoading = cfg.MCPLoading
	m.StartupResume = mode.Resume
	p := tea.NewProgram(m, tea.WithInput(terminalInput.Stdin), tea.WithOutput(ui.InstallTerminalOutput(os.Stdout)))

	finalModel, err := p.Run()
	model, hasModel := finalModel.(ui.Model)
	if hasModel {
		if cleanupErr := model.Dispose(); cleanupErr != nil {
			logger.Global().Error(map[string]any{"err": cleanupErr}, "terminal worker cleanup failed")
		}
	}
	terminalInput.Close()
	if err != nil {
		if crash_log.IsTerminalGone(err) {
			crash_log.ExitForTerminalGone("stdio", err)
		}
		telemetry.CaptureTelemetryError(err, "main")
		crash_log.RecordError("main", err)
		logger.Global().Fatal(map[string]any{"err": err}, "unhandled runtime error")
		telemetry.ShutdownTelemetry()
		exitNow(-1)
	}
	if hasModel {
		columns, _, sizeErr := term.GetSize(os.Stdout.Fd())
		if sizeErr != nil {
			columns = 80
		}
		fmt.Fprintln(os.Stdout, "\n"+ui.RenderInteractionSummary(model.InteractionSummary(), columns, term.IsTerminal(os.Stdout.Fd()), time.Now()))
	}
	telemetry.ShutdownTelemetry()
}

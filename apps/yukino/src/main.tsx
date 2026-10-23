import type { InteractionSummary } from "@yukino.js/bootstrap/interaction-summary.js";
import {
  forkEnabled,
  hydrateConfigEnv,
  loadConfig,
  memoryEnabled,
  withProjectMcpServers,
} from "@yukino.js/config";
import { initLogger, logger } from "@yukino.js/logger";
import { newSessionId } from "@yukino.js/session";
import {
  captureTelemetryError,
  initializeTelemetry,
  installRemoteTelemetrySignalHandlers,
  setTelemetryMode,
  shutdownTelemetry,
} from "@yukino.js/telemetry";
import { App } from "@yukino.js/ui/app.js";
import { renderInteractionSummary } from "@yukino.js/ui/interaction-summary.js";
import { setThemeMode } from "@yukino.js/ui/styles.js";
import { TerminalInput } from "@yukino.js/ui/terminal-input.js";
import { installTerminalOutput } from "@yukino.js/ui/terminal-output.js";
import { detectTerminalTheme } from "@yukino.js/ui/terminal-theme.js";
import { asErrorString } from "@yukino.js/utils";
import { render } from "ink";

import type { RuntimeMode } from "@/cli.js";
import { runPrintMode } from "@/print-mode.js";
import { recover, recordError, recordExit } from "@/recover.js";

async function runAcpMode(
  mode: Extract<RuntimeMode, { kind: "acp" | "acp-ws" }>,
): Promise<void> {
  await initializeTelemetry();
  setTelemetryMode("acp");
  try {
    if (mode.kind === "acp") {
      const { runAcpStdio } = await import("@yukino.js/acp/stdio.js");
      await runAcpStdio();
    } else {
      const { runAcpWebSocket } = await import("@yukino.js/acp/websocket.js");
      await runAcpWebSocket(mode.address);
    }
  } finally {
    await shutdownTelemetry();
  }
}

async function runA2aMode(address?: string): Promise<void> {
  await initializeTelemetry();
  setTelemetryMode("a2a");
  try {
    const { runA2aServer } = await import("@yukino.js/a2a/server.js");
    await runA2aServer(address);
  } finally {
    await shutdownTelemetry();
  }
}

async function runPrint(
  mode: Extract<RuntimeMode, { kind: "print" }>,
): Promise<void> {
  await initializeTelemetry();
  setTelemetryMode("print");
  try {
    await runPrintMode(mode);
  } catch (err) {
    captureTelemetryError(err, "print");
    console.error(`Error: ${asErrorString(err)}`);
    process.exitCode = 1;
  } finally {
    await shutdownTelemetry();
  }
}

async function runRemoteMode(
  mode: Extract<RuntimeMode, { kind: "remote" }>,
): Promise<void> {
  await initializeTelemetry();
  let cfg;
  try {
    cfg = withProjectMcpServers(
      loadConfig(undefined, { allowEmptyProviders: true }),
      process.cwd(),
    );
  } catch (err) {
    captureTelemetryError(err, "config");
    console.error(`Error: ${asErrorString(err)}`);
    await shutdownTelemetry();
    process.exitCode = 1;
    return;
  }

  setTelemetryMode("remote");
  const { RemoteServer } = await import("@yukino.js/remote/server.js");
  initLogger({ sessionId: newSessionId(), mode: "remote", stdout: true });
  const srv = new RemoteServer({
    providers: cfg.providers,
    defaultProvider: cfg.default_provider,
    mcpServers: cfg.mcp_servers,
    mcpLoading: cfg.mcp_loading,
    lspServers: cfg.lsp_servers,
    hookConfigs: cfg.hooks,
    sandboxConfig: cfg.sandbox,
    addr: mode.address,
    enableCoordinatorMode: cfg.enable_coordinator_mode ?? false,
    forkDisabled: !forkEnabled(cfg),
    memoryEnabled: memoryEnabled(cfg),
  });
  // Graceful shutdown on Ctrl+C/SIGTERM: stop the server (closes WS/HTTP,
  // kills detached background shells and teammates, disconnects MCP
  // children) and persist the real exit code before telemetry flushes.
  installRemoteTelemetrySignalHandlers(async (exitCode) => {
    try {
      await srv.stop();
    } catch {
      // best-effort — exiting regardless
    }
    recordExit(exitCode);
  });
  try {
    // Resolves only once the server has stopped (see RemoteServer.stop).
    await srv.run();
  } catch (err) {
    captureTelemetryError(err, "remote");
    console.error(`Remote server error: ${asErrorString(err)}`);
    await shutdownTelemetry();
    process.exitCode = 1;
  }
}

async function runUiMode(
  mode: Extract<RuntimeMode, { kind: "ui" }>,
): Promise<void> {
  await initializeTelemetry();
  let cfg;
  try {
    cfg = withProjectMcpServers(
      loadConfig(undefined, { allowEmptyProviders: true }),
      process.cwd(),
    );
  } catch (err) {
    captureTelemetryError(err, "config");
    console.error(`Error: ${asErrorString(err)}`);
    await shutdownTelemetry();
    process.exitCode = 1;
    return;
  }

  // UI mode: initialize logger before rendering.
  setTelemetryMode("terminal");
  initLogger({ sessionId: newSessionId(), mode: "terminal" });
  const terminalInput = new TerminalInput(process.stdin);
  let restoreTerminalOutput: (() => void) | undefined;
  let interactionSummary: InteractionSummary | undefined;
  try {
    setThemeMode(
      await detectTerminalTheme(terminalInput, { theme: cfg.theme }),
    );
    restoreTerminalOutput = installTerminalOutput();
    if (process.stdout.isTTY) {
      process.stdout.write("\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l");
    }
    const appProps = {
      config: cfg,
      providers: cfg.providers,
      permissionMode: cfg.permission_mode,
      mcpServers: cfg.mcp_servers,
      mcpLoading: cfg.mcp_loading,
      lspServers: cfg.lsp_servers,
      hooks: cfg.hooks,
      sandboxConfig: cfg.sandbox,
      enableCoordinatorMode: cfg.enable_coordinator_mode,
      forkDisabled: !forkEnabled(cfg),
      memoryEnabled: memoryEnabled(cfg),
      defaultProvider: cfg.default_provider,
    };
    const application = (
      <App
        {...appProps}
        resume={mode.resume}
        onExitSummary={(summary) => {
          interactionSummary = summary;
        }}
      />
    );
    const instance = render(application, {
      exitOnCtrlC: false,
      stdin: terminalInput.stdin,
    });
    await instance.waitUntilExit();
  } finally {
    restoreTerminalOutput?.();
    terminalInput.dispose();
  }
  if (interactionSummary) {
    process.stdout.write(`\n${renderInteractionSummary(interactionSummary)}\n`);
  }
  await shutdownTelemetry();
}

async function run(mode: RuntimeMode): Promise<void> {
  // Fill process.env from the config's `env` block before anything reads it:
  // every mode runner initializes telemetry (which reads OTEL_*/SENTRY_*/
  // LANGFUSE_*) before it loads the config.
  hydrateConfigEnv();
  recover();
  switch (mode.kind) {
    case "acp":
    case "acp-ws": {
      await runAcpMode(mode);
      return;
    }
    case "a2a": {
      await runA2aMode(mode.address);
      return;
    }
    case "print": {
      await runPrint(mode);
      return;
    }
    case "remote": {
      await runRemoteMode(mode);
      return;
    }
    case "ui": {
      await runUiMode(mode);
      return;
    }
  }
}

export async function runMode(mode: RuntimeMode): Promise<void> {
  try {
    await run(mode);
    recordExit(process.exitCode ?? 0);
  } catch (err: unknown) {
    captureTelemetryError(err, "main");
    recordError("main", err);
    logger.fatal({ err }, "unhandled runtime error");
    await shutdownTelemetry();
    process.exit(-1);
  }
}

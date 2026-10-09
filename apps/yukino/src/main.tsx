import { render } from "ink";

import type { InteractionSummary } from "./bootstrap/interaction-summary.js";
import {
  forkEnabled,
  loadConfig,
  memoryEnabled,
  withProjectMcpServers,
} from "./config/index.js";
import { initLogger, logger } from "./logger/index.js";
import { parsePrintFlags, runPrintMode } from "./print-mode.js";
import { recover, recordError, recordExit } from "./recover.js";
import { newSessionId } from "./session/index.js";
import {
  captureTelemetryError,
  initializeTelemetry,
  installRemoteTelemetrySignalHandlers,
  setTelemetryMode,
  shutdownTelemetry,
} from "./telemetry/index.js";
import { App } from "./ui/app.js";
import { renderInteractionSummary } from "./ui/interaction-summary.js";
import { parseResumeArgument } from "./ui/resume-argument.js";
import { setThemeMode } from "./ui/styles.js";
import { TerminalInput } from "./ui/terminal-input.js";
import { installTerminalOutput } from "./ui/terminal-output.js";
import { detectTerminalTheme } from "./ui/terminal-theme.js";
import { asErrorString } from "./utils/index.js";

async function main() {
  recover();
  const rawArgs = process.argv.slice(2);
  const printArgs = parsePrintFlags(rawArgs);
  const endOfOptions = rawArgs.indexOf("--");
  const printIndex = rawArgs.indexOf("-p");
  const args = rawArgs
    .slice(0, endOfOptions === -1 ? undefined : endOfOptions)
    .filter((_arg, index) => !printArgs || index !== printIndex + 1);

  if (args.includes("--acp") || args.includes("--acp-ws")) {
    await initializeTelemetry();
    setTelemetryMode("acp");
    const { runAcp } = await import("./acp/index.js");
    try {
      await runAcp(args);
    } finally {
      await shutdownTelemetry();
    }
    return;
  }

  if (args.includes("--a2a")) {
    await initializeTelemetry();
    setTelemetryMode("a2a");
    const { runA2a } = await import("./a2a/index.js");
    try {
      await runA2a(args);
    } finally {
      await shutdownTelemetry();
    }
    return;
  }

  await initializeTelemetry();
  if (args.includes("--remote") && args.includes("-p")) {
    throw new Error("--remote cannot be combined with -p.");
  }

  // Parse --remote and its optional listen address (defaults to port 18888).
  let remoteAddr = "";
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--remote") {
      remoteAddr = "18888";
      if (i + 1 < args.length && !args[i + 1].startsWith("-")) {
        remoteAddr = args[i + 1];
        i++;
      }
    }
  }

  if (printArgs) {
    setTelemetryMode("print");
    try {
      await runPrintMode(printArgs);
    } catch (err) {
      captureTelemetryError(err, "print");
      console.error(`Error: ${asErrorString(err)}`);
      process.exitCode = 1;
    } finally {
      await shutdownTelemetry();
    }
    return;
  }

  let cfg;
  try {
    cfg = withProjectMcpServers(
      loadConfig(undefined, { allowEmptyProviders: !remoteAddr }),
      process.cwd(),
    );
  } catch (err) {
    captureTelemetryError(err, "config");
    console.error(`Error: ${asErrorString(err)}`);
    await shutdownTelemetry();
    process.exitCode = 1;
    return;
  }

  if (args.includes("--remote") && remoteAddr) {
    setTelemetryMode("remote");
    const { RemoteServer } = await import("./remote/server.js");
    initLogger({ sessionId: newSessionId(), mode: "remote", stdout: true });
    const srv = new RemoteServer({
      providers: cfg.providers,
      defaultProvider: cfg.default_provider,
      mcpServers: cfg.mcp_servers,
      lspServers: cfg.lsp_servers,
      hookConfigs: cfg.hooks,
      sandboxConfig: cfg.sandbox,
      addr: remoteAddr,
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
    return;
  }

  // UI mode: initialize logger before rendering.
  setTelemetryMode("terminal");
  initLogger({ sessionId: newSessionId(), mode: "terminal" });
  const terminalInput = new TerminalInput(process.stdin);
  setThemeMode(await detectTerminalTheme(terminalInput));
  const restoreTerminalOutput = installTerminalOutput();
  if (process.stdout.isTTY) {
    process.stdout.write("\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l");
  }
  let interactionSummary: InteractionSummary | undefined;
  const appProps = {
    providers: cfg.providers,
    permissionMode: cfg.permission_mode,
    mcpServers: cfg.mcp_servers,
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
      resume={parseResumeArgument(args)}
      onExitSummary={(summary) => {
        interactionSummary = summary;
      }}
    />
  );
  try {
    const instance = render(application, {
      exitOnCtrlC: false,
      stdin: terminalInput.stdin,
    });
    await instance.waitUntilExit();
  } finally {
    restoreTerminalOutput();
    terminalInput.dispose();
  }
  if (interactionSummary) {
    process.stdout.write(`\n${renderInteractionSummary(interactionSummary)}\n`);
  }
  await shutdownTelemetry();
}

export async function runCli(): Promise<void> {
  try {
    await main();
    recordExit(process.exitCode ?? 0);
  } catch (err: unknown) {
    captureTelemetryError(err, "main");
    recordError("main", err);
    logger.fatal({ err }, "main() unhandled error");
    await shutdownTelemetry();
    process.exit(-1);
  }
}

/**
 * Copyright (c) 2026 hangtiancheng
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

/* eslint-disable no-console -- process entry point: pre-init errors and crash handlers need stderr output */

import { render } from "ink";

import {
  formatInteractionSummary,
  type InteractionSummary,
} from "./bootstrap/interaction-summary.js";
import {
  forkEnabled,
  loadConfig,
  withProjectMcpServers,
} from "./config/index.js";
import { initLogger, logger } from "./logger/index.js";
import { parsePrintFlags, runPrintMode } from "./print-mode.js";
import { recover, recordError, recordExit } from "./recover.js";
import { newSessionId } from "./session/index.js";
import { parseTeammateFlags, runTeammate } from "./teammate.js";
import {
  captureTelemetryError,
  initializeTelemetry,
  installRemoteTelemetrySignalHandlers,
  setTelemetryMode,
  shutdownTelemetry,
} from "./telemetry/index.js";
import { App } from "./ui/app.js";
import { setThemeMode } from "./ui/styles.js";
import { installSyncOutput } from "./ui/sync-output.js";
import { TerminalInput } from "./ui/terminal-input.js";
import { detectTerminalTheme } from "./ui/terminal-theme.js";
import { parseResumeArgument } from "./ui/ui-selection.js";
import { asErrorString } from "./utils/index.js";

async function main() {
  recover();
  const args = process.argv.slice(2);

  if (args.includes("--acp") || args.includes("--acp-ws")) {
    const { runAcp } = await import("./acp/index.js");
    await runAcp(args);
    return;
  }

  await initializeTelemetry();
  const teammateArgs = parseTeammateFlags(args);
  if (teammateArgs) {
    setTelemetryMode("teammate");
    try {
      await runTeammate(teammateArgs);
    } catch (err) {
      captureTelemetryError(err, "teammate");
      console.error(`teammate: ${asErrorString(err)}`);
      process.exitCode = 1;
    } finally {
      await shutdownTelemetry();
    }
    return;
  }

  // Parse --remote mode flags.
  let remoteAddr = "";
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--remote") {
      remoteAddr = ":18888";
      if (i + 1 < args.length && !args[i + 1].startsWith("-")) {
        remoteAddr = args[i + 1];
        i++;
      }
    }
  }

  // Parse --rpc mode: drive the Go agent bridge over protobuf/Connect instead
  // of the in-process agent. Also honours YUKINO_RPC_URL.
  let rpcUrl = process.env.YUKINO_RPC_URL ?? "";
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--rpc") {
      rpcUrl = "http://127.0.0.1:7860";
      if (i + 1 < args.length && !args[i + 1].startsWith("-")) {
        rpcUrl = args[i + 1];
        i++;
      }
    }
  }

  const printArgs = parsePrintFlags(args);
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
      loadConfig(undefined, { allowEmptyProviders: !remoteAddr && !rpcUrl }),
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
    installRemoteTelemetrySignalHandlers();
    const { RemoteServer } = await import("./remote/server.js");
    initLogger({ sessionId: newSessionId(), mode: "remote", stdout: true });
    const srv = new RemoteServer({
      providers: cfg.providers,
      mcpServers: cfg.mcp_servers,
      hookConfigs: cfg.hooks,
      addr: remoteAddr,
      enableCoordinatorMode: cfg.enable_coordinator_mode ?? false,
      forkDisabled: !forkEnabled(cfg),
    });
    try {
      await srv.run();
      // await new Promise(() => {
      //   /** noop */
      // });
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
  installSyncOutput();
  let interactionSummary: InteractionSummary | undefined;
  const appProps = {
    providers: cfg.providers,
    permissionMode: cfg.permission_mode,
    mcpServers: cfg.mcp_servers,
    hooks: cfg.hooks,
    sandboxConfig: cfg.sandbox,
    enableCoordinatorMode: cfg.enable_coordinator_mode,
    forkDisabled: !forkEnabled(cfg),
    rpcUrl: rpcUrl || undefined,
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
    terminalInput.dispose();
  }
  if (interactionSummary) {
    process.stdout.write(`\n${formatInteractionSummary(interactionSummary)}\n`);
  }
  await shutdownTelemetry();
}

main()
  .then(() => {
    recordExit(process.exitCode ?? 0);
  })
  .catch(async (err: unknown) => {
    captureTelemetryError(err, "main");
    recordError("main", err);
    logger.fatal({ err }, "main() unhandled error");
    await shutdownTelemetry();
    process.exit(-1);
  });

// @ts-check

import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import { execa } from "execa";

/** @type {{ command: string; config: import("@anthropic-ai/sandbox-runtime").SandboxRuntimeConfig; shellPath: string; commandId?: string }} */
const { command, config, shellPath, commandId } = JSON.parse(process.argv[2]);

const commandTempDirectory = process.env.TMPDIR;
// Runtime IPC sockets must fit Unix socket path limits even in deep worktrees.
process.env.TMPDIR = "/tmp";

// Each command owns its runtime: the upstream manager has process-global policy
// and cleanup, while worktree agents and background commands run concurrently.
try {
  const interrupted = new AbortController();
  const onInterrupt = () => interrupted.abort();
  process.once("SIGINT", onInterrupt);
  process.once("SIGTERM", onInterrupt);
  await SandboxManager.initialize(
    config,
    config.network.strictAllowlist ? undefined : async () => true,
  );
  interrupted.signal.throwIfAborted();
  if (commandTempDirectory) {
    process.env.CLAUDE_CODE_TMPDIR = commandTempDirectory;
  }
  const { argv, env } = await SandboxManager.wrapWithSandboxArgv(
    command,
    shellPath,
    undefined,
    interrupted.signal,
    process.cwd(),
    { commandId },
  );
  interrupted.signal.throwIfAborted();
  const result = await execa(argv[0], argv.slice(1), {
    env,
    extendEnv: false,
    stdio: "inherit",
    reject: false,
    cancelSignal: interrupted.signal,
    killDescendants: true,
  });
  const violations = SandboxManager.annotateStderrWithSandboxFailures(
    commandId || command,
    "",
  );
  if (violations) {
    process.stderr.write(violations);
  }
  process.exitCode = result.exitCode ?? 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  await SandboxManager.reset();
}

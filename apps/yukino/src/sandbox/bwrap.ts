import { execFileSync } from "node:child_process";

import type {
  Sandbox,
  SandboxConfig,
  SandboxExecutionContext,
} from "./index.js";

import { resolveToolPath } from "@/utils/paths.js";

/**
 * Linux bubblewrap (bwrap) sandbox implementation.
 * Leverages Linux user namespaces to create lightweight isolated environments.
 */
export class BwrapSandbox implements Sandbox {
  readonly implementation = "bwrap";

  private detected?: boolean;

  available(): boolean {
    if (this.detected !== undefined) {
      return this.detected;
    }
    try {
      execFileSync("which", ["bwrap"], { stdio: "ignore" });
      this.detected = true;
    } catch {
      this.detected = false;
    }
    return this.detected;
  }

  prepare(
    command: string,
    config: SandboxConfig,
    context: SandboxExecutionContext,
  ): { executable: string; args: string[] } {
    const args = ["--unshare-user", "--unshare-pid"];
    // If yukino dies without running its kill path (SIGKILL, crash), the
    // sandboxed process group must not outlive the session as an orphan.
    args.push("--die-with-parent");

    args.push("--ro-bind", "/", "/");

    for (const path of config.allowWrite.map((path) =>
      resolveToolPath(context.cwd, path),
    )) {
      args.push("--bind", path, path);
    }

    // Enforce read-only on denied paths; mounted after the allowWrite binds, so
    // they take precedence where the paths overlap
    for (const path of config.denyWrite.map((path) =>
      resolveToolPath(context.cwd, path),
    )) {
      args.push("--ro-bind", path, path);
    }

    if (!config.networkEnabled) {
      args.push("--unshare-net");
    }

    // Mount /proc, required by many commands
    args.push("--proc", "/proc");

    // "--" ends option parsing; the command runs via bash inside the sandbox
    args.push("--", "bash", "-c", command);

    return { executable: "bwrap", args };
  }
}

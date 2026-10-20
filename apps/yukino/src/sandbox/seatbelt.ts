import { existsSync, realpathSync } from "node:fs";

import { SANDBOX_EXEC_PATH } from "@/sandbox/constants.js";
import type {
  Sandbox,
  SandboxConfig,
  SandboxExecutionContext,
} from "@/sandbox/index.js";
import { resolveToolPath } from "@/utils/paths.js";

/**
 * macOS seatbelt sandbox implementation.
 * Dynamically generates a seatbelt profile to control file write and network access permissions.
 */
export class SeatbeltSandbox implements Sandbox {
  readonly implementation = "seatbelt";

  available(): boolean {
    return existsSync(SANDBOX_EXEC_PATH);
  }

  prepare(
    command: string,
    config: SandboxConfig,
    context: SandboxExecutionContext,
  ): { executable: string; args: string[] } {
    return {
      executable: SANDBOX_EXEC_PATH,
      args: [
        "-p",
        buildProfile({
          ...config,
          allowWrite: config.allowWrite.map((path) =>
            resolveToolPath(context.cwd, path),
          ),
          denyWrite: config.denyWrite.map((path) =>
            resolveToolPath(context.cwd, path),
          ),
        }),
        "bash",
        "-c",
        command,
      ],
    };
  }
}

/**
 * Expands a configured path to every form the kernel may report for it.
 * seatbelt matches canonical paths, so symlinked spellings (e.g. "/tmp" for
 * "/private/tmp", "/var/folders/..." for "/private/var/folders/...") never
 * hit a rule written against the symlink. Emitting both forms keeps rules
 * effective however the caller spelled the path.
 */
function pathVariants(path: string): string[] {
  const variants = new Set<string>([path]);
  try {
    variants.add(realpathSync(path));
  } catch {
    // Path may not exist yet; the original form is still emitted.
  }
  return [...variants];
}

function quoteProfileString(value: string): string {
  if (/\0|[\r\n]/u.test(value)) {
    throw new Error("Seatbelt paths cannot contain NUL or newline characters");
  }
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Dynamically builds a seatbelt profile string.
 * Strategy: deny by default, then allow execution and reads, grant writes per path,
 * deny writes per path, and finally configure network access.
 */
function buildProfile(config: SandboxConfig): string {
  const lines: string[] = [];

  lines.push("(version 1)");
  lines.push("(deny default)");

  lines.push("(allow process-exec)");
  lines.push("(allow process-fork)");
  lines.push("(allow sysctl-read)");
  lines.push('(allow file-read* (subpath "/"))');
  // Shell redirections ("> /dev/null", "2>&1", "&&" chains that discard output)
  // need to open /dev/null for writing. Grant only that node rather than the
  // whole /dev tree. Linux bwrap character-device behaviour is unverified here
  // and is intentionally left untouched until reproduced on Linux.
  lines.push('(allow file-write* (literal "/dev/null"))');

  for (const path of config.allowWrite) {
    for (const variant of pathVariants(path)) {
      lines.push(
        `(allow file-write* (subpath ${quoteProfileString(variant)}))`,
      );
    }
  }

  // Deny both the exact path and every descendant. Emitting both forms avoids
  // a build-time existence check whose result can become stale before launch.
  for (const path of config.denyWrite) {
    for (const variant of pathVariants(path)) {
      const quoted = quoteProfileString(variant);
      lines.push(`(deny file-write* (literal ${quoted}))`);
      lines.push(`(deny file-write* (subpath ${quoted}))`);
    }
  }

  if (config.networkEnabled) {
    lines.push("(allow network*)");
  } else {
    lines.push("(deny network*)");
  }

  return lines.join("\n");
}

import { tmpdir } from "node:os";

import type { SandboxYamlConfig } from "@/config/index.js";
import type { PermissionChecker } from "@/permissions/index.js";
import { createSandbox } from "@/sandbox/index.js";
import { BashTool } from "@/tools/bash.js";
import type { ToolRegistry } from "@/tools/registry.js";

export async function configureBashSandbox(
  registry: ToolRegistry,
  cwd: string,
  config?: SandboxYamlConfig,
  checker?: PermissionChecker,
): Promise<void> {
  const bash = registry.getInstanceOf("Bash", BashTool);
  if (!bash) {
    return;
  }
  bash.sandboxRequired = config?.enabled ?? false;
  if (bash.sandboxRequired) {
    bash.sandbox = await createSandbox();
    bash.sandboxConfig = {
      allowWrite: [cwd, tmpdir()],
      denyWrite: [],
      networkEnabled: config?.network_enabled ?? true,
    };
  }
  if (checker) {
    checker.sandboxEnabled = bash.sandboxRequired;
    checker.sandboxAutoAllow = config?.auto_allow ?? false;
  }
}

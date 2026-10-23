import { tmpdir } from "node:os";

import type { SandboxYamlConfig } from "@yukino.js/config";
import type { PermissionChecker } from "@yukino.js/permissions";
import { createSandbox } from "@yukino.js/sandbox";
import { BashTool } from "@yukino.js/tools/bash.js";
import type { ToolRegistry } from "@yukino.js/tools/registry.js";

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

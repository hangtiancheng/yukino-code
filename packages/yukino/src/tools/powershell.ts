import type { PreparedSandboxCommand } from "@/sandbox/index.js";
import {
  POWERSHELL_BACKGROUND_DESCRIPTION,
  POWERSHELL_COMMAND_DESCRIPTION,
  POWERSHELL_DESCRIPTION,
} from "@/tools/prompts.js";
import { ShellTool } from "@/tools/shell-tool.js";
import type { ToolContext } from "@/tools/types.js";

export class PowerShellTool extends ShellTool {
  name = "PowerShell";
  description = POWERSHELL_DESCRIPTION;
  protected commandDescription = POWERSHELL_COMMAND_DESCRIPTION;
  protected backgroundDescription = POWERSHELL_BACKGROUND_DESCRIPTION;
  protected prefix = "ps";
  protected prompt = "PS> ";

  protected prepareCommand(
    _ctx: ToolContext,
    command: string,
  ): PreparedSandboxCommand {
    const args = ["-NoProfile", "-NonInteractive"];
    if (process.platform === "win32") {
      return {
        executable: "powershell.exe",
        args: [
          ...args,
          "-ExecutionPolicy",
          "Bypass",
          "-Command",
          "try { [Console]::OutputEncoding=[System.Text.Encoding]::UTF8 } catch {}\n" +
            command,
        ],
      };
    }
    return { executable: "pwsh", args: [...args, "-Command", command] };
  }
}

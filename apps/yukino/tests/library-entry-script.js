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

async function script() {
  const m = await import(process.env.YUKINO_LIB_ENTRY);
  // The barrel exports one namespace per source directory, so symbols are
  // dot-separated paths (Group[.Sub].Name) resolved through the namespaces.
  const symbols = [
    "Agent.Agent",
    "Tools.Registry.ToolRegistry",
    "MCP.Manager.MCPManager",
    "Permissions.PermissionChecker",
    "Config.loadConfig",
    "LLM.Client.createClient",
    "Prompt.Builder.buildSystemPrompt",
    "Teams.TeamManager",
    "Todo.Tools.TaskCreateTool",
    "Teams.TaskTools.TeamTaskCreateTool",
    "Teams.TaskStop.TaskStopTool",
    "Todo.Store.TaskStore",
    "Recover.recover",
    "PrintMode.runPrintMode",
    "Remote.Server.RemoteServer",
    "Tools.ComputerUse.ComputerUseTool",
  ];
  const resolve = (path) =>
    path.split(".").reduce((object, key) => object?.[key], m);
  console.log(
    JSON.stringify({
      totalExports: Object.keys(m).length,
      version: m.Version.version,
      symbols: Object.fromEntries(symbols.map((k) => [k, typeof resolve(k)])),
    }),
  );
}

await script();

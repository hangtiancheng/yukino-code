async function script() {
  const m = await import(process.env.YUKINO_LIB_ENTRY);
  // The barrel exports one namespace per source directory, so symbols are
  // dot-separated paths (Namespace[.Sub].Symbol) resolved through the namespaces.
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

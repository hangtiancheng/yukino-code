async function script() {
  const m = await import(process.env.YUKINO_LIB_ENTRY);
  const symbols = [
    "Agent",
    "ToolRegistry",
    "MCPManager",
    "PermissionChecker",
    "loadConfig",
    "createClient",
    "buildSystemPrompt",
    "TeamManager",
    "TodoWriteTool",
    "TeamTodoWriteTool",
    "TaskStopTool",
    "TaskStore",
    "recover",
    "runPrintMode",
    "RemoteServer",
    "createAgentSession",
    "AgentSession",
    "SessionManager",
    "ComputerUseTool",
    "processImage",
    "defaultSyntaxTheme",
    "createTelemetryRuntime",
    "parseExporterTypes",
  ];
  for (const namespace of ["Remote", "Tools", "Config", "Conversation"]) {
    if (namespace in m) {
      throw new Error(`Unexpected namespace export: ${namespace}`);
    }
  }
  console.log(
    JSON.stringify({
      totalExports: Object.keys(m).length,
      version: m.version,
      symbols: Object.fromEntries(symbols.map((k) => [k, typeof m[k]])),
    }),
  );
}

await script();

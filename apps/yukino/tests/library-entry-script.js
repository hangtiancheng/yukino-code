import { register } from "node:module";

register(
  `data:text/javascript,${encodeURIComponent(`
    export function resolve(specifier, context, nextResolve) {
      if (["@langfuse/", "@opentelemetry/", "@sentry/"].some((prefix) => specifier.startsWith(prefix))) {
        throw new Error("Optional telemetry dependency is unavailable: " + specifier);
      }
      return nextResolve(specifier, context);
    }
  `)}`,
  import.meta.url,
);

async function script() {
  const m = await import(process.env.YUKINO_LIB_ENTRY);
  // The barrel is flat: every public symbol is a top-level named export.
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
    "ComputerUseTool",
  ];
  console.log(
    JSON.stringify({
      totalExports: Object.keys(m).length,
      version: m.version,
      symbols: Object.fromEntries(symbols.map((k) => [k, typeof m[k]])),
    }),
  );
}

await script();

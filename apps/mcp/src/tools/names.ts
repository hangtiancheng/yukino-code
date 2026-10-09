/** Public MCP tool names. Keep compound names; single-word tools use `_tool`. */
export const TOOL_NAMES = {
  createApp: "create_app",
  docsTool: "docs_tool",
  docsSync: "docs_sync",
  postgresTool: "postgres_tool",
  mysqlTool: "mysql_tool",
  redisTool: "redis_tool",
  mongodbTool: "mongodb_tool",
  prometheusTool: "prometheus_tool",
  githubTool: "github_tool",
} as const;

export type McpToolName = (typeof TOOL_NAMES)[keyof typeof TOOL_NAMES];

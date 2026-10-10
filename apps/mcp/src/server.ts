import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { modules } from "./tools/index.js";
import { TOOL_NAMES } from "./tools/names.js";
import { version } from "./version.js";

export const SERVER_NAME = "yukino-mcp";

const INSTRUCTIONS =
  `yukino-mcp provides tools for the Yukino CLI. Use ${TOOL_NAMES.docsTool} to semantically ` +
  "search the user's local knowledge base (Markdown/text files under ~/.yukino/docs) " +
  "whenever a question may be covered by project- or team-specific documents, " +
  `runbooks or notes. Use ${TOOL_NAMES.createApp} to display a self-contained HTML document as an ` +
  "interactive app (charts, dashboards, calculators, visual demos) inline in the " +
  "conversation when the user wants to see or interact with a result rather than " +
  "read text. " +
  `Use ${TOOL_NAMES.githubTool} to run any gh CLI command for GitHub repositories, ` +
  "issues, pull requests, reviews/merges, Actions, releases and projects. " +
  "Supply args without the leading gh. Use gh api for any REST endpoint and " +
  "gh api graphql for GraphQL queries/mutations; --paginate --slurp for pagination, " +
  "--json/--jq for focused output, stdin for --input - or --body-file -, and cwd " +
  "for local repository operations. Requires gh on PATH, with gh auth login or " +
  "GH_TOKEN/GITHUB_TOKEN. Use --help to discover subcommands and flags. " +
  `Use ${TOOL_NAMES.docsSync} after changing local knowledge-base files or to await initial indexing. ` +
  `Use ${TOOL_NAMES.postgresTool} and ${TOOL_NAMES.mysqlTool} to execute any SQL (including writes, DDL and ` +
  `multiple statements), ${TOOL_NAMES.redisTool} for arbitrary Redis command batches, ${TOOL_NAMES.mongodbTool} ` +
  `for any MongoDB database command, and ${TOOL_NAMES.prometheusTool} for PromQL, alerts, targets ` +
  "and any Prometheus HTTP API or administrative endpoint. Connection URLs may be " +
  "configured in the environment or supplied per call. Public tool names use " +
  "snake_case with at least two words; existing compound names remain unchanged.";

function assertUniqueModuleNames(): void {
  const seen = new Set<string>();
  for (const module of modules) {
    if (seen.has(module.name)) {
      throw new Error(`duplicate tool module name: ${module.name}`);
    }
    seen.add(module.name);
  }
}
assertUniqueModuleNames();

export function createServer(): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version },
    { instructions: INSTRUCTIONS },
  );
  for (const module of modules) {
    module.register(server);
  }
  return server;
}

import { readdirSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z, type core } from "zod";

import { logger } from "../../shared/logger.js";
import type { ToolModule } from "../types.js";
import { BROWSER_TOOLS } from "./browser-tools.js";
import { createChromeSocketClient } from "./mcp-server.js";
import { handleToolCall } from "./tool-calls.js";
import type {
  YukinoForChromeContext,
  Logger as ChromeLogger,
  SocketClient,
} from "./types.js";

const SERVER_NAME = "Yukino Chrome";

const chromeLogger: ChromeLogger = {
  info: (message, detail) => logger.info({ err: detail }, message),
  error: (message, detail) => logger.error({ err: detail }, message),
  warn: (message, detail) => logger.warn({ err: detail }, message),
  debug: (message, detail) => logger.debug({ err: detail }, message),
  silly: (message, detail) => logger.trace({ err: detail }, message),
};

function getUsername(): string {
  try {
    return userInfo().username || "default";
  } catch {
    return process.env["USER"] || process.env["USERNAME"] || "default";
  }
}

// Wire contract with the Chrome extension's native messaging host: the socket
// name and the client_id below must match what the native host creates and
// expects. The "claude-" prefix is legacy naming kept for compatibility —
// do not rename without changing the extension side in lockstep.
const SOCKET_NAME = `claude-mcp-browser-bridge-${getUsername()}`;

function getChromeSocketPaths(): string[] {
  if (process.platform === "win32") {
    return [`\\\\.\\pipe\\${SOCKET_NAME}`];
  }

  const paths = new Set<string>();
  const socketDirectory = `/tmp/${SOCKET_NAME}`;
  try {
    for (const file of readdirSync(socketDirectory)) {
      if (file.endsWith(".sock")) {
        paths.add(join(socketDirectory, file));
      }
    }
  } catch {
    // The native host creates the directory when Chrome starts it.
  }

  paths.add(join(tmpdir(), SOCKET_NAME));
  paths.add(`/tmp/${SOCKET_NAME}`);
  return [...paths];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const REGISTERED_BROWSER_TOOLS = BROWSER_TOOLS.map((tool) => ({
  name: tool.name,
  title: "title" in tool ? tool.title : undefined,
  description: tool.description,
  inputSchema: z.fromJSONSchema(
    z.custom<core.JSONSchema.JSONSchema>(isRecord).parse(tool.inputSchema),
  ),
}));

export function createChromeToolModule(
  context: YukinoForChromeContext,
  socketClient: SocketClient = createChromeSocketClient(context),
): ToolModule {
  return {
    name: "chrome",

    register(server: McpServer): void {
      if (context.isDisabled?.()) {
        return;
      }

      for (const tool of REGISTERED_BROWSER_TOOLS) {
        server.registerTool(
          tool.name,
          {
            title: tool.title,
            description: tool.description,
            inputSchema: tool.inputSchema,
          },
          async (args) => {
            if (!isRecord(args)) {
              return {
                content: [
                  { type: "text", text: `Invalid arguments for ${tool.name}` },
                ],
                isError: true,
              };
            }
            return handleToolCall(context, socketClient, tool.name, args);
          },
        );
      }
    },

    shutdown(): Promise<void> {
      socketClient.disconnect();
      return Promise.resolve();
    },
  };
}

const context: YukinoForChromeContext = {
  serverName: SERVER_NAME,
  logger: chromeLogger,
  socketPath:
    process.platform === "win32"
      ? `\\\\.\\pipe\\${SOCKET_NAME}`
      : join(tmpdir(), SOCKET_NAME),
  getSocketPaths: getChromeSocketPaths,
  clientTypeId: "claude-code",
  onToolCallDisconnected: () =>
    "Chrome browser extension is not connected. Ensure the Yukino browser extension is installed, enabled, and running, then retry.",
};

export const chromeModule = createChromeToolModule(context);

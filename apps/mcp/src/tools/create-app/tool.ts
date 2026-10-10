import { readFile } from "node:fs/promises";

import {
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { logger } from "@/shared/logger.js";
import { TOOL_NAMES } from "@/tools/names.js";
import type { ToolModule } from "@/tools/types.js";

export const CREATED_APP_RESOURCE_URI = "ui://create-app/create-app.html";

const RESOURCE_DOMAINS = [
  "https://unpkg.com",
  "https://cdn.jsdelivr.net",
  "https://cdn.tailwindcss.com",
  "https://cdnjs.cloudflare.com",
  "https://esm.sh",
  "https://fonts.googleapis.com",
  "https://fonts.gstatic.com",
];

const MAX_HTML_CHARS = 200_000;

const InputSchema = {
  html: z
    .string()
    .min(1)
    .max(MAX_HTML_CHARS)
    .describe(
      "Complete, self-contained HTML document to render (doctype, styles and scripts " +
        "inlined). Scripts run in a sandboxed iframe without storage or cookies. " +
        `External assets may only load from popular CDNs (${RESOURCE_DOMAINS.join(", ")}). ` +
        `Keep it under ${String(MAX_HTML_CHARS)} characters.`,
    ),
  title: z
    .string()
    .min(1)
    .max(120)
    .default("MCP App")
    .describe("Short human-readable label shown above the app."),
};

const NO_UI_FALLBACK_NOTE =
  "Agentic app delivered via the create_app UI; hosts without MCP Apps support " +
  "cannot display it.";

async function readAppHtml(): Promise<string> {
  const sibling = new URL("./create-app.html", import.meta.url);
  const appHtmlUrl = sibling.pathname.endsWith("/dist/create-app.html")
    ? sibling
    : new URL("../../../dist/create-app.html", import.meta.url);

  try {
    return await readFile(appHtmlUrl, "utf-8");
  } catch (err) {
    logger.error(
      { err, path: appHtmlUrl.pathname },
      "create_app UI shell is unavailable",
    );
    throw new Error("create_app UI shell is unavailable; run pnpm build:fe", {
      cause: err,
    });
  }
}

export const createAppModule: ToolModule = {
  name: "create_app",

  register(server: McpServer): void {
    registerAppTool(
      server,
      TOOL_NAMES.createApp,
      {
        title: "MCP App",
        description:
          "Create a complete HTML document as an interactive app (MCP App) inline in the " +
          "conversation. Use it whenever the user wants to see or interact with a result " +
          "rather than read text: charts, dashboards, diagrams, calculators, small " +
          "simulations, games or forms. The HTML must be self-contained (inline CSS/JS); " +
          "it runs in a sandboxed iframe, so there is no storage, cookies or access to " +
          "the host. Returns app metadata; UI-capable hosts display the app automatically.",
        inputSchema: InputSchema,
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
        _meta: { ui: { resourceUri: CREATED_APP_RESOURCE_URI } },
      },
      async ({ html, title }) => {
        try {
          await readAppHtml();
        } catch (err) {
          return {
            content: [
              {
                type: "text",
                text: err instanceof Error ? err.message : String(err),
              },
            ],
            isError: true,
          };
        }
        logger.debug({ bytes: html.length, title }, "create_app invoked");
        return {
          content: [
            {
              type: "text",
              text: `Rendered interactive app "${title}". ${NO_UI_FALLBACK_NOTE}`,
            },
          ],
          structuredContent: { title },
          _meta: { html, title },
        };
      },
    );

    registerAppResource(
      server,
      "Create App UI",
      CREATED_APP_RESOURCE_URI,
      {
        description:
          "Sandboxed shell that displays the create_app tool result as an interactive app.",
      },
      async () => ({
        contents: [
          {
            uri: CREATED_APP_RESOURCE_URI,
            mimeType: RESOURCE_MIME_TYPE,
            text: await readAppHtml(),
            _meta: { ui: { csp: { resourceDomains: RESOURCE_DOMAINS } } },
          },
        ],
      }),
    );
  },
};

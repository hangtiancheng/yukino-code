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

import { readFile } from "node:fs/promises";

import {
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { logger } from "../../shared/logger.js";
import type { ToolModule } from "../types.js";

export const CREATED_APP_RESOURCE_URI = "ui://create-app/create-app.html";

// The shell renders user HTML through a same-document srcdoc iframe, which
// inherits the host's CSP for the app resource. Without this allowlist, every
// CDN script/font/style in model-authored HTML would be silently blocked.
const RESOURCE_DOMAINS = [
  "https://unpkg.com",
  "https://cdn.jsdelivr.net",
  "https://cdn.tailwindcss.com",
  "https://cdnjs.cloudflare.com",
  "https://esm.sh",
  "https://fonts.googleapis.com",
  "https://fonts.gstatic.com",
];

// Tool results and the UI bridge are JSON; a large cap keeps them within
// typical host message limits while still allowing rich single-file apps.
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
    logger.error({ err, path: appHtmlUrl.pathname }, "create_app UI shell is unavailable");
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
      "create_app",
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

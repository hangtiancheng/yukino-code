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

// Client for the Claude Code VSCode extension's embedded MCP server. After
// connecting we announce ourselves with `ide_connected` (the extension routes
// Cmd+Option+K to the CLI whose pid matches the active terminal) and listen
// for `at_mentioned` notifications carrying file path + 0-based line range.

import { setTimeout as delay } from "node:timers/promises";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { z } from "zod";

import { detectIde } from "./lockfile.js";
import { WebSocketTransport } from "./ws-transport.js";

import { createChildLogger } from "@/logger/index.js";
import { version } from "@/version.js";

const log = createChildLogger({ module: "vscode" });

export interface IdeAtMention {
  filePath: string;
  /** 1-based */
  lineStart?: number;
  /** 1-based */
  lineEnd?: number;
}

export interface IdeConnection {
  ideName: string;
  close: () => Promise<void>;
}

const AtMentionedSchema = z.object({
  method: z.literal("at_mentioned"),
  params: z.object({
    filePath: z.string(),
    lineStart: z.number().optional(),
    lineEnd: z.number().optional(),
  }),
});

function inIdeTerminal(): boolean {
  return (
    process.env.CLAUDE_CODE_SSE_PORT !== undefined ||
    process.env.TERM_PROGRAM === "vscode"
  );
}

export async function connectToIde(opts: {
  cwd: string;
  onAtMentioned: (mention: IdeAtMention) => void;
  onDisconnect?: () => void;
  signal?: AbortSignal;
}): Promise<IdeConnection | null> {
  // Only poll when we're plausibly inside an IDE terminal — the extension
  // may still be activating right after the window opens.
  const deadline = Date.now() + (inIdeTerminal() ? 30_000 : 0);

  if (opts.signal?.aborted) {
    return null;
  }
  let ide = await detectIde(opts.cwd);
  while (!ide && Date.now() < deadline) {
    try {
      await delay(1000, undefined, { signal: opts.signal });
    } catch {
      return null;
    }
    ide = await detectIde(opts.cwd);
  }
  if (!ide || opts.signal?.aborted) {
    return null;
  }

  const transport = new WebSocketTransport(ide.url, {
    ...(ide.authToken && { "X-Claude-Code-Ide-Authorization": ide.authToken }),
  });
  const client = new Client({ name: "yukino", version }, {});

  try {
    await client.connect(transport, { signal: opts.signal });
    if (opts.signal?.aborted) {
      await client.close();
      return null;
    }
  } catch (err) {
    await client.close().catch(() => undefined);
    if (!opts.signal?.aborted) {
      log.error({ err, url: ide.url }, "failed to connect to IDE extension");
    }
    return null;
  }

  // Protocol.connect() wraps transport.onclose for its own teardown, so we
  // must not overwrite it; the SDK re-exposes the close signal as client.onclose.
  client.onclose = () => {
    opts.onDisconnect?.();
  };

  client.setNotificationHandler(AtMentionedSchema, (notification: unknown) => {
    const parsed = AtMentionedSchema.safeParse(notification);
    if (!parsed.success) {
      return;
    }
    const { filePath, lineStart, lineEnd } = parsed.data.params;
    opts.onAtMentioned({
      filePath,
      // Extension sends 0-based lines; expose 1-based like editors display.
      lineStart: lineStart !== undefined ? lineStart + 1 : undefined,
      lineEnd: lineEnd !== undefined ? lineEnd + 1 : undefined,
    });
  });

  try {
    await client.notification({
      method: "ide_connected",
      params: { pid: process.pid },
    });
  } catch (err) {
    log.error({ err }, "failed to send ide_connected notification");
  }

  return {
    ideName: ide.ideName,
    close: async () => {
      client.onclose = undefined;
      try {
        await client.close();
      } catch (err) {
        log.error({ err }, "failed to close IDE client");
      }
    },
  };
}

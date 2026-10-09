import { readFile, stat } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import z from "zod";

import type { Tool, ToolContext, ToolResult, ToolSchema } from "./types.js";

import { LspClient } from "@/lsp/client.js";
import type { LspServerConfig } from "@/lsp/config.js";
import { asErrorString, isRecord } from "@/utils/index.js";
import { resolveToolPath } from "@/utils/paths.js";

const operations = [
  "definition",
  "references",
  "hover",
  "documentSymbol",
  "workspaceSymbol",
  "implementation",
  "typeDefinition",
  "prepareCallHierarchy",
  "incomingCalls",
  "outgoingCalls",
  "diagnostics",
] as const;
const Args = z
  .object({
    operation: z.enum(operations),
    file_path: z.string().min(1),
    line: z.number().int().min(1).optional(),
    character: z.number().int().min(1).optional(),
    query: z.string().optional(),
  })
  .strict()
  .superRefine((args, ctx) => {
    if (
      !["documentSymbol", "workspaceSymbol", "diagnostics"].includes(
        args.operation,
      ) &&
      (args.line === undefined || args.character === undefined)
    ) {
      ctx.addIssue({
        code: "custom",
        message: "This operation requires 1-based line and character (UTF-16).",
      });
    }
    if (args.operation === "workspaceSymbol" && !args.query?.trim()) {
      ctx.addIssue({
        code: "custom",
        message: "workspaceSymbol requires a non-empty query",
      });
    }
  });

interface DocumentState {
  text: string;
  version: number;
}
interface Session {
  client: LspClient;
  documents: Map<string, DocumentState>;
  diagnostics: Map<string, { version: number; items: unknown[] }>;
  queue: Promise<void>;
}

function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) {
    return promise;
  }
  signal.throwIfAborted();
  return new Promise((resolvePromise, reject) => {
    const abort = () => {
      reject(new Error("LSP operation interrupted"));
    };
    signal.addEventListener("abort", abort, { once: true });
    promise
      .then(resolvePromise, reject)
      .finally(() => {
        signal.removeEventListener("abort", abort);
      })
      .catch(() => undefined);
  });
}

export class LspTool implements Tool {
  name = "LSP";
  description =
    "Query a configured language server for definitions, references, hover, symbols, implementations, type definitions, call hierarchy, or diagnostics. file_path resolves against the current working directory; line and character are 1-based UTF-16 positions. Returned ranges use the LSP standard (0-based UTF-16) and file URIs. This tool cannot edit files or run arbitrary commands. Servers must be explicitly configured in lsp_servers; no automatic installation.";
  category = "read" as const;
  private sessions = new Map<string, Promise<Session>>();
  private disposed = false;
  constructor(private configs: readonly LspServerConfig[]) {}

  schema(): ToolSchema {
    return {
      name: this.name,
      description: this.description,
      input_schema: {
        type: "object",
        properties: {
          operation: { type: "string", enum: [...operations] },
          file_path: { type: "string" },
          line: { type: "integer", minimum: 1 },
          character: { type: "integer", minimum: 1 },
          query: { type: "string" },
        },
        required: ["operation", "file_path"],
        additionalProperties: false,
      },
    };
  }

  private session(config: LspServerConfig, cwd: string): Promise<Session> {
    if (this.disposed) {
      throw new Error("LSP tool is disposed");
    }
    const key = JSON.stringify([cwd, config.name]);
    let promise = this.sessions.get(key);
    if (!promise) {
      promise = (async () => {
        const client = new LspClient(config, cwd);
        const session: Session = {
          client,
          documents: new Map(),
          diagnostics: new Map(),
          queue: Promise.resolve(),
        };
        client.onNotification((method, params) => {
          if (
            method !== "textDocument/publishDiagnostics" ||
            !isRecord(params) ||
            typeof params.uri !== "string" ||
            !Array.isArray(params.diagnostics)
          ) {
            return;
          }
          const document = session.documents.get(params.uri);
          if (
            !document ||
            (typeof params.version === "number" &&
              params.version !== document.version)
          ) {
            return;
          }
          session.diagnostics.set(params.uri, {
            version: document.version,
            items: params.diagnostics,
          });
        });
        try {
          await client.initialize();
          return session;
        } catch (error) {
          await client.dispose();
          throw error;
        }
      })();
      this.sessions.set(key, promise);
      const current = promise;
      void current.catch(() => {
        if (this.sessions.get(key) === current) {
          this.sessions.delete(key);
        }
      });
    }
    return promise;
  }

  private async query(
    session: Session,
    config: LspServerConfig,
    filePath: string,
    args: z.infer<typeof Args>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    signal?.throwIfAborted();
    if (session.client.isClosed) {
      throw new Error("LSP server exited; retry to start a fresh server");
    }
    const info = await stat(filePath);
    if (!info.isFile() || info.size > 10 * 1024 * 1024) {
      throw new Error("LSP requires a regular file no larger than 10MB");
    }
    const text = await readFile(filePath, { encoding: "utf8", signal });
    const uri = pathToFileURL(filePath).href;
    const previous = session.documents.get(uri);
    if (previous?.text !== text) {
      const version = (previous?.version ?? 0) + 1;
      session.documents.set(uri, { text, version });
      session.diagnostics.delete(uri);
      if (!previous) {
        session.client.notify("textDocument/didOpen", {
          textDocument: {
            uri,
            languageId: config.languages[extname(filePath)],
            version,
            text,
          },
        });
      } else {
        session.client.notify("textDocument/didChange", {
          textDocument: { uri, version },
          contentChanges: [{ text }],
        });
      }
    }
    const textDocument = { uri };
    const position = {
      line: (args.line ?? 1) - 1,
      character: (args.character ?? 1) - 1,
    };
    if (args.line !== undefined) {
      const lines = text.split(/\r?\n/u);
      if (
        position.line >= lines.length ||
        position.character > (lines[position.line]?.length ?? 0)
      ) {
        throw new Error("LSP position is outside the document");
      }
    }
    if (args.operation === "workspaceSymbol") {
      return session.client.request(
        "workspace/symbol",
        { query: args.query },
        signal,
      );
    }
    if (args.operation === "documentSymbol") {
      return session.client.request(
        "textDocument/documentSymbol",
        { textDocument },
        signal,
      );
    }
    if (args.operation === "diagnostics") {
      if (session.client.capabilities.diagnosticProvider) {
        return session.client.request(
          "textDocument/diagnostic",
          { textDocument },
          signal,
        );
      }
      const current = session.diagnostics.get(uri);
      if (current) {
        return { items: current.items, pending: false };
      }
      return new Promise((resolvePromise, reject) => {
        const finish = (error?: Error) => {
          clearTimeout(timer);
          unsubscribe();
          signal?.removeEventListener("abort", abort);
          if (error) {
            reject(error);
          } else {
            const diagnostics = session.diagnostics.get(uri);
            resolvePromise({
              items: diagnostics?.items ?? [],
              pending: !diagnostics,
            });
          }
        };
        const abort = () => {
          finish(new Error("LSP operation interrupted"));
        };
        const timer = setTimeout(
          () => {
            finish();
          },
          Math.min(2000, config.timeout_ms ?? 15_000),
        );
        const unsubscribe = session.client.onNotification((method, params) => {
          if (
            method === "textDocument/publishDiagnostics" &&
            isRecord(params) &&
            params.uri === uri &&
            session.diagnostics.has(uri)
          ) {
            finish();
          }
        });
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) {
          abort();
        }
      });
    }
    if (
      args.operation === "incomingCalls" ||
      args.operation === "outgoingCalls"
    ) {
      const prepared = await session.client.request(
        "textDocument/prepareCallHierarchy",
        { textDocument, position },
        signal,
      );
      if (!Array.isArray(prepared)) {
        return [];
      }
      const results = [];
      for (const item of z.array(z.unknown()).parse(prepared)) {
        results.push({
          item,
          calls: await session.client.request(
            `callHierarchy/${args.operation}`,
            { item },
            signal,
          ),
        });
      }
      return results;
    }
    return session.client.request(
      `textDocument/${args.operation}`,
      {
        textDocument,
        position,
        ...(args.operation === "references"
          ? { context: { includeDeclaration: true } }
          : {}),
      },
      signal,
    );
  }

  async execute(
    ctx: ToolContext,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const parsed = Args.safeParse(args);
    if (!parsed.success) {
      return { output: parsed.error.message, isError: true };
    }
    try {
      ctx.abortSignal?.throwIfAborted();
      const cwd = resolve(ctx.cwd);
      const filePath = resolveToolPath(cwd, parsed.data.file_path);
      const config = this.configs.find((server) =>
        Object.hasOwn(server.languages, extname(filePath)),
      );
      if (!config) {
        throw new Error(
          `No LSP server configured for '${extname(filePath)}'. Add an installed server to lsp_servers.`,
        );
      }
      const info = await stat(filePath);
      if (!info.isFile() || info.size > 10 * 1024 * 1024) {
        throw new Error("LSP requires a regular file no larger than 10MB");
      }
      const key = JSON.stringify([cwd, config.name]);
      const activeSession = this.session(config, cwd);
      let session = await abortable(activeSession, ctx.abortSignal);
      if (session.client.isClosed) {
        await session.client.dispose();
        if (this.sessions.get(key) === activeSession) {
          this.sessions.delete(key);
        }
        session = await abortable(this.session(config, cwd), ctx.abortSignal);
      }
      const current = session;
      const result = current.queue.then(() =>
        this.query(current, config, filePath, parsed.data, ctx.abortSignal),
      );
      current.queue = result.then(
        () => undefined,
        () => undefined,
      );
      const output =
        JSON.stringify(await abortable(result, ctx.abortSignal), null, 2) ??
        "null";
      return {
        output:
          output.length > 100_000
            ? `${output.slice(0, 100_000)}\n[Truncated; narrow the query.]`
            : output,
        isError: false,
      };
    } catch (error) {
      return { output: `Error: ${asErrorString(error)}`, isError: true };
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    const sessions = await Promise.allSettled([...this.sessions.values()]);
    this.sessions.clear();
    await Promise.all(
      sessions.flatMap((result) =>
        result.status === "fulfilled" ? [result.value.client.dispose()] : [],
      ),
    );
  }
}

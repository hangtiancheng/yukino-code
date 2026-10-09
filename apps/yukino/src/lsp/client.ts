import {
  execFile,
  spawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { pathToFileURL } from "node:url";

import type { LspServerConfig } from "./config.js";

import { registerExitCleanup } from "@/bootstrap/exit-cleanup.js";
import { asErrorString, isRecord } from "@/utils/index.js";

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  cleanup: () => void;
}

export class LspClient {
  private child: ChildProcessWithoutNullStreams;
  private buffer: Buffer = Buffer.alloc(0);
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private closed = false;
  private processClosed = false;
  private disposal?: Promise<void>;
  private stderr = "";
  private unregister: () => void;
  private exited: Promise<void>;
  private notifications = new Set<(method: string, params: unknown) => void>();
  capabilities: Record<string, unknown> = {};

  constructor(
    private config: LspServerConfig,
    private cwd: string,
  ) {
    this.child = spawn(config.command, config.args ?? [], {
      cwd: cwd,
      env: { ...process.env, ...config.env },
      shell: false,
      detached: process.platform !== "win32",
      stdio: "pipe",
    });
    this.unregister = registerExitCleanup(() => {
      this.killTree();
    });
    this.exited = new Promise((resolve) => {
      this.child.once("close", () => {
        this.processClosed = true;
        this.fail(
          new Error(
            `LSP server '${config.name}' exited${this.stderr ? `: ${this.stderr}` : ""}`,
          ),
        );
        this.unregister();
        resolve();
      });
    });
    this.child.on("error", (error) => {
      this.fail(error);
    });
    this.child.stdin.on("error", (error) => {
      this.fail(error);
    });
    this.child.stderr.on("data", (chunk: Buffer) => {
      this.stderr = (this.stderr + chunk.toString("utf8")).slice(-4000);
    });
    this.child.stdout.on("data", (chunk: Buffer) => {
      try {
        this.receive(chunk);
      } catch (error) {
        this.fail(new Error(`Invalid LSP response: ${asErrorString(error)}`));
        this.killTree();
      }
    });
  }

  get isClosed(): boolean {
    return this.closed;
  }

  private killTree(): void {
    const pid = this.child.pid;
    if (this.processClosed || pid === undefined) {
      return;
    }
    if (process.platform === "win32") {
      execFile("taskkill", ["/pid", String(pid), "/t", "/f"], () => undefined);
    } else {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        this.child.kill("SIGKILL");
      }
    }
  }

  private fail(error: Error): void {
    this.closed = true;
    for (const request of this.pending.values()) {
      request.cleanup();
      request.reject(error);
    }
    this.pending.clear();
  }

  private send(message: Record<string, unknown>): void {
    if (this.closed) {
      throw new Error(`LSP server '${this.config.name}' is not running`);
    }
    const body = Buffer.from(
      JSON.stringify({ jsonrpc: "2.0", ...message }),
      "utf8",
    );
    this.child.stdin.write(
      Buffer.concat([
        Buffer.from(`Content-Length: ${String(body.length)}\r\n\r\n`, "ascii"),
        body,
      ]),
    );
  }

  notify(method: string, params?: unknown): void {
    this.send({ method, ...(params === undefined ? {} : { params }) });
  }

  request(
    method: string,
    params?: unknown,
    signal?: AbortSignal,
    timeoutMs = this.config.timeout_ms ?? 15_000,
  ): Promise<unknown> {
    signal?.throwIfAborted();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const cancel = (error: Error) => {
        const request = this.pending.get(id);
        if (!request) {
          return;
        }
        this.pending.delete(id);
        request.cleanup();
        try {
          this.notify("$/cancelRequest", { id });
        } catch {
          /* The server may already have exited. */
        }
        reject(error);
      };
      const abort = () => {
        cancel(new Error("LSP request interrupted"));
      };
      const timer = setTimeout(() => {
        cancel(
          new Error(`LSP ${method} timed out after ${String(timeoutMs)}ms`),
        );
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
      };
      this.pending.set(id, { resolve, reject, cleanup });
      signal?.addEventListener("abort", abort, { once: true });
      try {
        this.send({ id, method, ...(params === undefined ? {} : { params }) });
      } catch (error) {
        this.pending.delete(id);
        cleanup();
        reject(
          error instanceof Error ? error : new Error(asErrorString(error)),
        );
      }
    });
  }

  private receive(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) {
        if (this.buffer.length > 8192) {
          throw new Error("LSP header exceeds 8KB");
        }
        return;
      }
      if (headerEnd > 8192) {
        throw new Error("LSP header exceeds 8KB");
      }
      const matches = [
        ...this.buffer
          .subarray(0, headerEnd)
          .toString("ascii")
          .matchAll(/^Content-Length:\s*(\d+)\s*$/gimu),
      ];
      if (matches.length !== 1) {
        throw new Error("Expected one Content-Length header");
      }
      const length = Number(matches[0]?.[1]);
      if (!Number.isSafeInteger(length) || length > 16 * 1024 * 1024) {
        throw new Error("LSP message exceeds 16MB");
      }
      if (this.buffer.length < headerEnd + 4 + length) {
        return;
      }
      const message: unknown = JSON.parse(
        this.buffer
          .subarray(headerEnd + 4, headerEnd + 4 + length)
          .toString("utf8"),
      );
      this.buffer = this.buffer.subarray(headerEnd + 4 + length);
      if (!isRecord(message) || message.jsonrpc !== "2.0") {
        throw new Error("Invalid JSON-RPC message");
      }
      if (typeof message.method === "string") {
        if (message.id !== undefined) {
          this.respond(message);
        } else {
          for (const listener of this.notifications) {
            listener(message.method, message.params);
          }
        }
      } else if (typeof message.id === "number") {
        const request = this.pending.get(message.id);
        if (!request) {
          continue;
        }
        this.pending.delete(message.id);
        request.cleanup();
        if (isRecord(message.error)) {
          request.reject(
            new Error(
              typeof message.error.message === "string"
                ? message.error.message
                : "LSP request failed",
            ),
          );
        } else {
          request.resolve(message.result);
        }
      }
    }
  }

  private respond(message: Record<string, unknown>): void {
    const params = isRecord(message.params) ? message.params : {};
    switch (message.method) {
      case "workspace/applyEdit":
        this.send({
          id: message.id,
          result: {
            applied: false,
            failureReason:
              "Yukino LSP is read-only; use authorized file tools for edits.",
          },
        });
        return;
      case "workspace/configuration": {
        const items = Array.isArray(params.items) ? params.items : [];
        this.send({
          id: message.id,
          result: items.map((item: unknown) => {
            let value: unknown = this.config.settings ?? {};
            if (isRecord(item) && typeof item.section === "string") {
              for (const key of item.section.split(".")) {
                value = isRecord(value) ? value[key] : undefined;
              }
            }
            return value ?? null;
          }),
        });
        return;
      }
      case "workspace/workspaceFolders":
        this.send({
          id: message.id,
          result: [{ uri: pathToFileURL(this.cwd).href, name: this.cwd }],
        });
        return;
      case "window/showMessageRequest":
      case "window/workDoneProgress/create":
        this.send({ id: message.id, result: null });
        return;
      default:
        this.send({
          id: message.id,
          error: {
            code: -32601,
            message: "Unsupported read-only client method",
          },
        });
    }
  }

  onNotification(
    listener: (method: string, params: unknown) => void,
  ): () => void {
    this.notifications.add(listener);
    return () => {
      this.notifications.delete(listener);
    };
  }

  async initialize(): Promise<void> {
    const result = await this.request("initialize", {
      processId: process.pid,
      clientInfo: { name: "yukino" },
      rootUri: pathToFileURL(this.cwd).href,
      workspaceFolders: [{ uri: pathToFileURL(this.cwd).href, name: this.cwd }],
      initializationOptions: this.config.initialization_options,
      capabilities: {
        general: { positionEncodings: ["utf-16"] },
        workspace: {
          configuration: true,
          workspaceFolders: true,
          applyEdit: false,
        },
        textDocument: {
          synchronization: { dynamicRegistration: false },
          publishDiagnostics: { versionSupport: true },
          diagnostic: { dynamicRegistration: false },
        },
      },
    });
    if (!isRecord(result) || !isRecord(result.capabilities)) {
      throw new Error("Invalid LSP initialize response");
    }
    this.capabilities = result.capabilities;
    if (
      this.capabilities.positionEncoding &&
      this.capabilities.positionEncoding !== "utf-16"
    ) {
      throw new Error("Only UTF-16 LSP positions are supported");
    }
    this.notify("initialized", {});
    if (this.config.settings) {
      this.notify("workspace/didChangeConfiguration", {
        settings: this.config.settings,
      });
    }
  }

  dispose(): Promise<void> {
    return (this.disposal ??= this.close());
  }

  private async close(): Promise<void> {
    if (!this.closed) {
      try {
        await this.request("shutdown", undefined, undefined, 500);
        this.notify("exit");
      } catch {
        /* Force termination below if graceful shutdown fails. */
      }
    }
    this.fail(new Error("LSP client disposed"));
    this.notifications.clear();
    this.child.stdin.end();
    const timer = setTimeout(() => {
      this.killTree();
    }, 500);
    try {
      await this.exited;
    } finally {
      clearTimeout(timer);
      this.unregister();
    }
  }
}

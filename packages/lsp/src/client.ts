import {
  execFile,
  spawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { pathToFileURL } from "node:url";

import { registerExitCleanup } from "@yukino.js/bootstrap/exit-cleanup.js";
import { asErrorString, isRecord } from "@yukino.js/utils";

import type { LspServerConfig } from "./config.js";
import {
  APPLY_EDIT_FAILURE_REASON,
  CLIENT_DISPOSED_ERROR,
  CLIENT_NAME,
  CONTENT_LENGTH_EXPECTED_ERROR,
  CONTENT_LENGTH_HEADER,
  CONTENT_LENGTH_HEADER_PATTERN,
  DEFAULT_REQUEST_TIMEOUT_MS,
  HEADER_DELIMITER,
  HEADER_TOO_LARGE_ERROR,
  INVALID_INITIALIZE_RESPONSE_ERROR,
  INVALID_JSONRPC_ERROR,
  JSONRPC_VERSION,
  KILL_DELAY_MS,
  MAX_HEADER_BYTES,
  MAX_MESSAGE_BYTES,
  MAX_STDERR_CHARS,
  MESSAGE_TOO_LARGE_ERROR,
  METHOD_APPLY_EDIT,
  METHOD_CANCEL_REQUEST,
  METHOD_CONFIGURATION,
  METHOD_DID_CHANGE_CONFIGURATION,
  METHOD_EXIT,
  METHOD_INITIALIZE,
  METHOD_INITIALIZED,
  METHOD_NOT_FOUND_ERROR_CODE,
  METHOD_SHOW_MESSAGE_REQUEST,
  METHOD_SHUTDOWN,
  METHOD_WORKSPACE_FOLDERS,
  METHOD_WORK_DONE_PROGRESS_CREATE,
  POSITION_ENCODING_UTF16,
  REQUEST_FAILED_ERROR,
  REQUEST_INTERRUPTED_ERROR,
  SHUTDOWN_TIMEOUT_MS,
  UNSUPPORTED_METHOD_ERROR,
  UNSUPPORTED_POSITION_ENCODING_ERROR,
} from "./constants.js";

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
      this.stderr = (this.stderr + chunk.toString("utf8")).slice(
        -MAX_STDERR_CHARS,
      );
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
      JSON.stringify({ jsonrpc: JSONRPC_VERSION, ...message }),
      "utf8",
    );
    this.child.stdin.write(
      Buffer.concat([
        Buffer.from(
          `${CONTENT_LENGTH_HEADER}: ${String(body.length)}${HEADER_DELIMITER}`,
          "ascii",
        ),
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
    timeoutMs = this.config.timeout_ms ?? DEFAULT_REQUEST_TIMEOUT_MS,
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
          this.notify(METHOD_CANCEL_REQUEST, { id });
        } catch {
          /* The server may already have exited. */
        }
        reject(error);
      };
      const abort = () => {
        cancel(new Error(REQUEST_INTERRUPTED_ERROR));
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
      const headerEnd = this.buffer.indexOf(HEADER_DELIMITER);
      if (headerEnd < 0) {
        if (this.buffer.length > MAX_HEADER_BYTES) {
          throw new Error(HEADER_TOO_LARGE_ERROR);
        }
        return;
      }
      if (headerEnd > MAX_HEADER_BYTES) {
        throw new Error(HEADER_TOO_LARGE_ERROR);
      }
      const matches = [
        ...this.buffer
          .subarray(0, headerEnd)
          .toString("ascii")
          .matchAll(CONTENT_LENGTH_HEADER_PATTERN),
      ];
      if (matches.length !== 1) {
        throw new Error(CONTENT_LENGTH_EXPECTED_ERROR);
      }
      const length = Number(matches[0]?.[1]);
      if (!Number.isSafeInteger(length) || length > MAX_MESSAGE_BYTES) {
        throw new Error(MESSAGE_TOO_LARGE_ERROR);
      }
      const bodyStart = headerEnd + HEADER_DELIMITER.length;
      if (this.buffer.length < bodyStart + length) {
        return;
      }
      const message: unknown = JSON.parse(
        this.buffer.subarray(bodyStart, bodyStart + length).toString("utf8"),
      );
      this.buffer = this.buffer.subarray(bodyStart + length);
      if (!isRecord(message) || message.jsonrpc !== JSONRPC_VERSION) {
        throw new Error(INVALID_JSONRPC_ERROR);
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
                : REQUEST_FAILED_ERROR,
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
      case METHOD_APPLY_EDIT:
        this.send({
          id: message.id,
          result: {
            applied: false,
            failureReason: APPLY_EDIT_FAILURE_REASON,
          },
        });
        return;
      case METHOD_CONFIGURATION: {
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
      case METHOD_WORKSPACE_FOLDERS:
        this.send({
          id: message.id,
          result: [{ uri: pathToFileURL(this.cwd).href, name: this.cwd }],
        });
        return;
      case METHOD_SHOW_MESSAGE_REQUEST:
      case METHOD_WORK_DONE_PROGRESS_CREATE:
        this.send({ id: message.id, result: null });
        return;
      default:
        this.send({
          id: message.id,
          error: {
            code: METHOD_NOT_FOUND_ERROR_CODE,
            message: UNSUPPORTED_METHOD_ERROR,
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
    const result = await this.request(METHOD_INITIALIZE, {
      processId: process.pid,
      clientInfo: { name: CLIENT_NAME },
      rootUri: pathToFileURL(this.cwd).href,
      workspaceFolders: [{ uri: pathToFileURL(this.cwd).href, name: this.cwd }],
      initializationOptions: this.config.initialization_options,
      capabilities: {
        general: { positionEncodings: [POSITION_ENCODING_UTF16] },
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
      throw new Error(INVALID_INITIALIZE_RESPONSE_ERROR);
    }
    this.capabilities = result.capabilities;
    if (
      this.capabilities.positionEncoding &&
      this.capabilities.positionEncoding !== POSITION_ENCODING_UTF16
    ) {
      throw new Error(UNSUPPORTED_POSITION_ENCODING_ERROR);
    }
    this.notify(METHOD_INITIALIZED, {});
    if (this.config.settings) {
      this.notify(METHOD_DID_CHANGE_CONFIGURATION, {
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
        await this.request(
          METHOD_SHUTDOWN,
          undefined,
          undefined,
          SHUTDOWN_TIMEOUT_MS,
        );
        this.notify(METHOD_EXIT);
      } catch {
        /* Force termination below if graceful shutdown fails. */
      }
    }
    this.fail(new Error(CLIENT_DISPOSED_ERROR));
    this.notifications.clear();
    this.child.stdin.end();
    const timer = setTimeout(() => {
      this.killTree();
    }, KILL_DELAY_MS);
    try {
      await this.exited;
    } finally {
      clearTimeout(timer);
      this.unregister();
    }
  }
}

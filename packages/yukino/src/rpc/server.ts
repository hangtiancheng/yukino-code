import { randomUUID } from "node:crypto";
import type { Readable, Writable } from "node:stream";

import type { z } from "zod";

import {
  RPC_CONTROL_COMMANDS,
  RPC_CONTROL_REQUEST_RESERVE,
  RPC_MAX_LINE_BYTES,
  RPC_INTERACTION_LIMIT,
  RPC_INTERACTION_TIMEOUT_MS,
  RPC_MAX_COMMAND_IDS,
  RPC_MAX_PENDING_REQUESTS,
  RPC_VERSION,
} from "@/rpc/constants.js";
import { JsonlDecoder, JsonlWriter } from "@/rpc/jsonl.js";
import {
  parseRpcRequest,
  type RpcCommand,
  type RpcError,
  type RpcMessage,
  type RpcRequest,
} from "@/rpc/protocol.js";

export type RpcHandler = (args: Record<string, unknown>) => unknown;
export interface RpcHost {
  sessionId(): string;
  handlers: Partial<Record<RpcCommand, RpcHandler>>;
  subscribe(listener: (event: unknown) => void): () => void;
  abort(): void | Promise<void>;
  dispose: () => Promise<void>;
}

interface Interaction {
  sessionId: string;
  validate: (value: unknown) => unknown;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  cleanup: () => void;
}

export class RpcServer {
  private writer: JsonlWriter;
  private pending = new Map<string, Promise<void>>();
  private seen = new Set<string>();
  private interactions = new Map<string, Interaction>();
  private sequence = 0;
  private stopped = false;
  private closing?: Promise<void>;
  private unsubscribe: () => void;
  private input?: Readable;

  constructor(
    private host: RpcHost,
    output: Writable,
  ) {
    this.writer = new JsonlWriter(output);
    this.unsubscribe = host.subscribe((event) => {
      if (this.stopped) {
        return;
      }
      void this.writer
        .write({
          version: RPC_VERSION,
          type: "event",
          sequence: ++this.sequence,
          sessionId: host.sessionId(),
          event,
        })
        .catch(() => {
          void this.stop().catch(() => undefined);
        });
    });
  }

  async run(input: Readable): Promise<void> {
    this.input = input;
    const decoder = new JsonlDecoder();
    try {
      for await (const chunk of input) {
        if (this.stopped) {
          break;
        }
        const bytes: unknown = chunk;
        if (typeof bytes !== "string" && !Buffer.isBuffer(bytes)) {
          await this.reject(null, "invalid_request", "Expected UTF-8 input");
          continue;
        }
        const lines = decoder.push(bytes);
        const errors = decoder.takeErrors();
        for (let index = 0; index < errors; index++) {
          await this.reject(
            null,
            "invalid_request",
            "RPC line size limit exceeded",
          );
        }
        for (const line of lines) {
          this.receive(line);
        }
      }
      if (!this.stopped) {
        for (const line of decoder.finish()) {
          this.receive(line);
        }
        const errors = decoder.takeErrors();
        for (let index = 0; index < errors; index++) {
          await this.reject(
            null,
            "invalid_request",
            "RPC line size limit exceeded",
          );
        }
      }
    } catch (error) {
      if (
        !this.stopped ||
        !(error instanceof Error) ||
        !("code" in error) ||
        error.code !== "ERR_STREAM_PREMATURE_CLOSE"
      ) {
        throw error;
      }
    } finally {
      await this.stop();
    }
  }

  receive(line: string): void {
    if (this.stopped) {
      return;
    }
    let request: RpcRequest;
    try {
      request = parseRpcRequest(JSON.parse(line));
    } catch {
      void this.reject(null, "invalid_request", "Invalid RPC request").catch(
        () => {
          void this.stop().catch(() => undefined);
        },
      );
      return;
    }
    if (this.seen.has(request.commandId)) {
      void this.reject(
        request.commandId,
        "invalid_request",
        "Duplicate commandId",
      ).catch(() => {
        void this.stop().catch(() => undefined);
      });
      return;
    }
    const pendingLimit =
      RPC_MAX_PENDING_REQUESTS -
      (RPC_CONTROL_COMMANDS.has(request.command)
        ? 0
        : RPC_CONTROL_REQUEST_RESERVE);
    if (this.pending.size >= pendingLimit) {
      void this.reject(
        request.commandId,
        "busy",
        "Too many pending requests",
      ).catch(() => {
        void this.stop().catch(() => undefined);
      });
      return;
    }
    if (this.seen.size >= RPC_MAX_COMMAND_IDS) {
      void this.reject(
        request.commandId,
        "busy",
        "Connection command limit reached; reconnect to continue",
      ).catch(() => {
        void this.stop().catch(() => undefined);
      });
      return;
    }
    this.seen.add(request.commandId);
    const operation = this.execute(request)
      .catch(() => {
        void this.stop().catch(() => undefined);
      })
      .finally(() => {
        this.pending.delete(request.commandId);
      });
    this.pending.set(request.commandId, operation);
  }

  private async execute(request: RpcRequest): Promise<void> {
    const { commandId, command, args } = request;
    if (command === "get_commands") {
      await this.respond(commandId, [
        ...new Set([
          "get_commands",
          "interaction_response",
          ...Object.keys(this.host.handlers),
        ]),
      ]);
      return;
    }
    if (command === "interaction_response") {
      const result = this.respondInteraction(args);
      if (!result) {
        await this.reject(
          commandId,
          "stale_interaction",
          "Interaction is stale or the response is invalid",
        );
      } else {
        await this.respond(commandId, { accepted: true });
      }
      return;
    }
    const handler = this.host.handlers[command];
    if (!handler) {
      await this.reject(
        commandId,
        "unsupported_command",
        "Command is not available in this host",
      );
      return;
    }
    if (command === "prompt" || command === "bash") {
      await this.respond(commandId, {
        accepted: true,
        sessionId: this.host.sessionId(),
      });
      try {
        if (this.stopped) {
          throw new Error("RPC server closed");
        }
        const result = await handler(args);
        await this.writer.write({
          version: RPC_VERSION,
          type: "event",
          sequence: ++this.sequence,
          sessionId: this.host.sessionId(),
          commandId,
          event: { type: "command_completed", command, result },
        });
      } catch {
        await this.writer.write({
          version: RPC_VERSION,
          type: "event",
          sequence: ++this.sequence,
          sessionId: this.host.sessionId(),
          commandId,
          event: {
            type: "command_failed",
            command,
            error: { code: "execution_failed", message: "Command failed" },
          },
        });
      }
      return;
    }
    try {
      await this.respond(commandId, await handler(args));
    } catch {
      await this.reject(
        commandId,
        "execution_failed",
        command === "export_session"
          ? "Export failed; exports above 1MiB require export_session_begin"
          : "Command failed",
      );
    }
  }

  emit(event: unknown, commandId?: string): Promise<void> {
    return this.writer.write({
      version: RPC_VERSION,
      type: "event",
      sequence: ++this.sequence,
      sessionId: this.host.sessionId(),
      event,
      ...(commandId ? { commandId } : {}),
    });
  }

  requestInteraction<T>(
    kind: string,
    payload: unknown,
    schema: z.ZodType<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    if (this.stopped) {
      return Promise.reject(new Error("RPC server closed"));
    }
    if (this.interactions.size >= RPC_INTERACTION_LIMIT) {
      return Promise.reject(new Error("RPC interaction limit exceeded"));
    }
    signal?.throwIfAborted();
    const interactionId = randomUUID();
    const sessionId = this.host.sessionId();
    return new Promise<T>((resolve, reject) => {
      const cleanup = (): void => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        this.interactions.delete(interactionId);
      };
      const abort = (): void => {
        cleanup();
        reject(new Error("RPC interaction cancelled"));
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("RPC interaction expired"));
      }, RPC_INTERACTION_TIMEOUT_MS);
      this.interactions.set(interactionId, {
        sessionId,
        validate: (value) => schema.parse(value),
        cleanup,
        resolve: (value) => {
          resolve(schema.parse(value));
        },
        reject,
      });
      signal?.addEventListener("abort", abort, { once: true });
      void this.writer
        .write({
          version: RPC_VERSION,
          type: "interaction",
          interactionId,
          sessionId,
          kind,
          expiresAt: Date.now() + RPC_INTERACTION_TIMEOUT_MS,
          payload,
        })
        .catch(() => {
          cleanup();
          reject(new Error("RPC output unavailable"));
        });
    });
  }

  private respondInteraction(args: Record<string, unknown>): boolean {
    const key =
      typeof args.interactionId === "string" ? args.interactionId : "";
    const interaction = this.interactions.get(key);
    if (
      !interaction ||
      args.sessionId !== interaction.sessionId ||
      this.host.sessionId() !== interaction.sessionId
    ) {
      return false;
    }
    let response: unknown;
    try {
      response = interaction.validate(args.response);
    } catch {
      return false;
    }
    interaction.cleanup();
    interaction.resolve(response);
    return true;
  }

  private respond(commandId: string, result: unknown): Promise<void> {
    const message: RpcMessage = {
      version: RPC_VERSION,
      type: "response" as const,
      commandId,
      success: true as const,
      result: result ?? null,
    };
    if (Buffer.byteLength(JSON.stringify(message)) + 1 > RPC_MAX_LINE_BYTES) {
      return this.reject(
        commandId,
        "result_too_large",
        "Result exceeds 1MiB; use bounded transfer commands",
      );
    }
    return this.writer.write(message);
  }

  private reject(
    commandId: string | null,
    code: RpcError["code"],
    message: string,
  ): Promise<void> {
    return this.writer.write({
      version: RPC_VERSION,
      type: "response",
      commandId,
      success: false,
      error: { code, message },
    });
  }

  stop(): Promise<void> {
    this.closing ??= (async () => {
      this.stopped = true;
      this.input?.destroy();
      this.unsubscribe();
      for (const interaction of [...this.interactions.values()]) {
        interaction.cleanup();
        interaction.reject(new Error("RPC server closed"));
      }
      const errors: unknown[] = [];
      try {
        await this.host.abort();
      } catch (error) {
        errors.push(error);
      }
      for (const cleanup of [
        () => this.host.dispose(),
        () => Promise.allSettled(this.pending.values()),
        () => this.writer.flush(),
      ]) {
        try {
          await cleanup();
        } catch (error) {
          errors.push(error);
        }
      }
      this.writer.dispose();
      if (errors.length) {
        throw new AggregateError(errors, "RPC cleanup failed");
      }
    })();
    return this.closing;
  }
}

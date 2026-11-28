import type { Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";

import {
  RPC_MAX_LINE_BYTES,
  RPC_MAX_OUTPUT_BYTES,
  RPC_OUTPUT_DRAIN_TIMEOUT_MS,
} from "@/rpc/constants.js";
import type { RpcMessage } from "@/rpc/protocol.js";

export class JsonlDecoder {
  private decoder = new StringDecoder("utf8");
  private buffer = "";
  private discarding = false;
  private invalidLines = 0;

  push(chunk: Buffer | string): string[] {
    this.buffer +=
      typeof chunk === "string" ? chunk : this.decoder.write(chunk);
    const lines: string[] = [];
    let end: number;
    while ((end = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, end).replace(/\r$/u, "");
      this.buffer = this.buffer.slice(end + 1);
      if (this.discarding || Buffer.byteLength(line) > RPC_MAX_LINE_BYTES) {
        this.invalidLines++;
        this.discarding = false;
      } else if (line.trim()) {
        lines.push(line);
      }
    }
    const pendingBytes =
      Buffer.byteLength(this.buffer) - Number(this.buffer.endsWith("\r"));
    if (this.discarding || pendingBytes > RPC_MAX_LINE_BYTES) {
      this.discarding = true;
      this.buffer = "";
    }
    return lines;
  }

  takeErrors(): number {
    const count = this.invalidLines;
    this.invalidLines = 0;
    return count;
  }

  finish(): string[] {
    return this.push(this.decoder.end() + "\n");
  }
}

export class JsonlWriter {
  private pendingBytes = 0;
  private tail = Promise.resolve();
  private failure: Error | undefined;

  constructor(private output: Writable) {
    output.on("error", this.onError);
  }

  private onError = (error: Error): void => {
    this.failure = error;
  };

  write(message: RpcMessage): Promise<void> {
    const line = JSON.stringify(message) + "\n";
    const size = Buffer.byteLength(line);
    if (this.pendingBytes + size > RPC_MAX_OUTPUT_BYTES) {
      return Promise.reject(
        new Error("RPC output backpressure limit exceeded"),
      );
    }
    this.pendingBytes += size;
    const result = this.tail
      .then(async () => {
        if (this.failure) {
          throw this.failure;
        }
        if (this.output.destroyed || this.output.writableEnded) {
          throw new Error("RPC output closed");
        }
        await new Promise<void>((resolve, reject) => {
          let callbackFailure: ReturnType<typeof setImmediate> | undefined;
          const cleanup = (): void => {
            clearTimeout(timer);
            clearImmediate(callbackFailure);
            this.output.off("close", close);
            this.output.off("error", error);
          };
          const close = (): void => {
            cleanup();
            reject(new Error("RPC output closed"));
          };
          const error = (cause: Error): void => {
            cleanup();
            reject(cause instanceof Error ? cause : new Error(String(cause)));
          };
          const timer = setTimeout(() => {
            cleanup();
            reject(new Error("RPC output drain deadline exceeded"));
          }, RPC_OUTPUT_DRAIN_TIMEOUT_MS);
          this.output.once("close", close);
          this.output.once("error", error);
          try {
            this.output.write(line, (cause) => {
              if (cause) {
                // Node emits write errors after the callback; keep listeners until then.
                callbackFailure = setImmediate(() => {
                  error(cause);
                });
              } else {
                cleanup();
                resolve();
              }
            });
          } catch (cause) {
            cleanup();
            reject(cause instanceof Error ? cause : new Error(String(cause)));
          }
        });
      })
      .finally(() => {
        this.pendingBytes -= size;
      });
    this.tail = result.catch((error: unknown) => {
      this.failure =
        error instanceof Error ? error : new Error("RPC output failed");
    });
    return result;
  }

  async flush(): Promise<void> {
    await this.tail;
    if (this.failure) {
      throw this.failure;
    }
  }

  dispose(): void {
    this.output.off("error", this.onError);
  }
}

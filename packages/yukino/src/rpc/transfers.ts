import { createHash, randomUUID, type Hash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readSync,
  realpathSync,
  rmdirSync,
  unlinkSync,
  type Stats,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";

import type { z } from "zod";

import {
  RPC_TRANSFER_CHUNK_BYTES,
  RPC_TRANSFER_LIMIT,
  RPC_TRANSFER_MAX_BYTES,
  RPC_TRANSFER_TEMP_PREFIX,
  RPC_TRANSFER_TTL_MS,
} from "@/rpc/constants.js";
import {
  RpcExportBeginSchema,
  RpcImportBeginSchema,
  RpcTransferBindingSchema,
  RpcTransferReadSchema,
  RpcTransferWriteSchema,
} from "@/rpc/protocol.js";
import type { AgentSession } from "@/sdk/agent-session.js";
import { writeAllSync } from "@/storage/file-io.js";
import { cancelOnSignal } from "@/utils/cancel.js";

type Binding = z.infer<typeof RpcTransferBindingSchema>;
type Session = Pick<
  AgentSession,
  | "sessionId"
  | "cwd"
  | "sessionManager"
  | "isDisposed"
  | "exportStream"
  | "importStream"
>;
interface Transfer {
  id: string;
  sessionId: string;
  revision: number;
  kind: "export" | "import";
  cwd: string;
  size: number;
  offset: number;
  sha256: string;
  hash: Hash;
  directory: string;
  directoryIdentity: Stats;
  path: string;
  fd: number;
  identity: Stats;
  controller: AbortController;
  expiresAt: number;
  timer: ReturnType<typeof setTimeout>;
  operation?: Promise<unknown>;
  closed: boolean;
}
function sameFile(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}
function checksum(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Host-owned, pull-only storage. No client path is ever used for temporary files or cleanup. */
export class RpcTransfers {
  private transfers = new Map<string, Transfer>();
  private closing?: Promise<void>;
  private aborted: () => void;

  constructor(
    private session: Session,
    private signal: AbortSignal,
  ) {
    this.aborted = () => {
      void this.dispose().catch(() => undefined);
    };
    signal.addEventListener("abort", this.aborted, { once: true });
  }
  private create(
    kind: Transfer["kind"],
    size: number,
    sha256: string,
    cwd: string,
  ): Transfer {
    this.signal.throwIfAborted();
    if (this.closing || this.session.isDisposed) {
      throw new Error("RPC transfers closed");
    }
    if (this.transfers.size >= RPC_TRANSFER_LIMIT) {
      throw new Error("RPC concurrent transfer limit exceeded");
    }
    this.session.sessionManager.refresh();
    const directory = mkdtempSync(
      join(realpathSync(tmpdir()), RPC_TRANSFER_TEMP_PREFIX),
    );
    const directoryIdentity = lstatSync(directory);
    const id = randomUUID();
    const path = join(directory, id);
    let fd: number;
    try {
      fd = openSync(
        path,
        constants.O_RDWR |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o600,
      );
    } catch (error) {
      rmdirSync(directory);
      throw error;
    }
    const transfer: Transfer = {
      id,
      kind,
      size,
      sha256,
      cwd,
      offset: 0,
      sessionId: this.session.sessionId,
      revision: this.session.sessionManager.revision,
      hash: createHash("sha256"),
      directory,
      directoryIdentity,
      path,
      fd,
      identity: fstatSync(fd),
      controller: new AbortController(),
      closed: false,
      expiresAt: Date.now() + RPC_TRANSFER_TTL_MS,
      timer: setTimeout(() => {
        void this.cancelOwned(transfer).catch(() => undefined);
      }, RPC_TRANSFER_TTL_MS),
    };
    transfer.timer.unref();
    this.transfers.set(id, transfer);
    return transfer;
  }
  private descriptor(transfer: Transfer) {
    return {
      transferId: transfer.id,
      sessionId: transfer.sessionId,
      revision: transfer.revision,
      size: transfer.size,
      sha256: transfer.sha256,
      chunkBytes: RPC_TRANSFER_CHUNK_BYTES,
      expiresAt: transfer.expiresAt,
    };
  }
  private assertFile(transfer: Transfer): void {
    const directory = lstatSync(transfer.directory);
    const named = lstatSync(transfer.path);
    const opened = fstatSync(transfer.fd);
    if (
      !directory.isDirectory() ||
      directory.isSymbolicLink() ||
      !sameFile(directory, transfer.directoryIdentity) ||
      realpathSync(transfer.directory) !== transfer.directory ||
      !named.isFile() ||
      named.isSymbolicLink() ||
      named.nlink !== 1 ||
      opened.nlink !== 1 ||
      !sameFile(named, transfer.identity) ||
      !sameFile(opened, transfer.identity) ||
      opened.size !== transfer.identity.size ||
      opened.mtimeMs !== transfer.identity.mtimeMs ||
      opened.ctimeMs !== transfer.identity.ctimeMs
    ) {
      throw new Error("Unsafe RPC transfer file replacement or modification");
    }
  }
  private assertCurrent(transfer: Transfer): void {
    this.signal.throwIfAborted();
    transfer.controller.signal.throwIfAborted();
    this.session.sessionManager.refresh();
    if (
      transfer.closed ||
      this.session.isDisposed ||
      Date.now() >= transfer.expiresAt ||
      this.session.sessionId !== transfer.sessionId ||
      this.session.sessionManager.revision !== transfer.revision
    ) {
      throw new Error("RPC transfer expired or session revision changed");
    }
    this.assertFile(transfer);
  }
  private lookup(args: Binding): Transfer {
    const transfer = this.transfers.get(args.transferId);
    if (
      transfer?.sessionId !== args.sessionId ||
      transfer.revision !== args.revision
    ) {
      throw new Error("Unknown or incorrectly bound RPC transfer");
    }
    try {
      this.assertCurrent(transfer);
    } catch (error) {
      void this.cancelOwned(transfer).catch(() => undefined);
      throw error;
    }
    return transfer;
  }
  private run<T>(transfer: Transfer, work: () => T | Promise<T>): Promise<T> {
    if (transfer.operation) {
      return Promise.reject(
        new Error("RPC transfer operation already pending"),
      );
    }
    const operation = Promise.resolve()
      .then(work)
      .finally(() => {
        transfer.operation = undefined;
      });
    transfer.operation = operation;
    return operation;
  }
  private write(transfer: Transfer, bytes: Uint8Array, offset: number): void {
    this.assertFile(transfer);
    writeAllSync(transfer.fd, bytes, offset);
    transfer.identity = fstatSync(transfer.fd);
    transfer.hash.update(bytes);
  }
  beginExport(args: Record<string, unknown>) {
    const options = RpcExportBeginSchema.parse(args);
    const transfer = this.create("export", 0, "", this.session.cwd);
    return this.run(transfer, async () => {
      const signal = AbortSignal.any([this.signal, transfer.controller.signal]);
      const iterator = this.session.exportStream({ ...options, signal });
      let complete = false;
      try {
        while (true) {
          const chunk = await cancelOnSignal(() => iterator.next(), signal);
          this.assertCurrent(transfer);
          if (chunk.done) {
            complete = true;
            break;
          }
          if (
            !(chunk.value instanceof Uint8Array) ||
            !chunk.value.byteLength ||
            chunk.value.byteLength > RPC_TRANSFER_CHUNK_BYTES ||
            transfer.size + chunk.value.byteLength > RPC_TRANSFER_MAX_BYTES
          ) {
            throw new Error("RPC transfer byte quota exceeded");
          }
          this.write(transfer, chunk.value, transfer.size);
          transfer.size += chunk.value.byteLength;
        }
        fsyncSync(transfer.fd);
        transfer.identity = fstatSync(transfer.fd);
        transfer.sha256 = transfer.hash.copy().digest("hex");
        this.assertCurrent(transfer);
        return this.descriptor(transfer);
      } catch (error) {
        this.cleanup(transfer);
        throw error;
      } finally {
        if (!complete) {
          void iterator.return(undefined).catch(() => undefined);
        }
      }
    });
  }
  beginImport(args: Record<string, unknown>) {
    const options = RpcImportBeginSchema.parse(args);
    return this.descriptor(
      this.create(
        "import",
        options.size,
        options.sha256,
        options.cwd ?? this.session.cwd,
      ),
    );
  }
  read(args: Record<string, unknown>) {
    const options = RpcTransferReadSchema.parse(args);
    const transfer = this.lookup(options);
    return this.run(transfer, () => {
      this.assertCurrent(transfer);
      if (
        transfer.kind !== "export" ||
        options.offset !== transfer.offset ||
        transfer.offset >= transfer.size
      ) {
        throw new Error("RPC transfer read kind or offset mismatch");
      }
      const length = Math.min(options.length, transfer.size - transfer.offset);
      const bytes = Buffer.allocUnsafe(length);
      const count = readSync(transfer.fd, bytes, 0, length, transfer.offset);
      if (count !== length) {
        throw new Error("Incomplete RPC transfer file");
      }
      this.assertCurrent(transfer);
      transfer.offset += count;
      return {
        offset: options.offset,
        length: count,
        data: bytes.toString("base64"),
        sha256: checksum(bytes),
        eof: transfer.offset === transfer.size,
      };
    });
  }
  writeChunk(args: Record<string, unknown>) {
    const options = RpcTransferWriteSchema.parse(args);
    const transfer = this.lookup(options);
    return this.run(transfer, () => {
      this.assertCurrent(transfer);
      if (
        transfer.kind !== "import" ||
        options.offset !== transfer.offset ||
        transfer.offset + options.length > transfer.size
      ) {
        throw new Error("RPC transfer write kind, offset or quota mismatch");
      }
      const bytes = Buffer.from(options.data, "base64");
      if (
        bytes.length !== options.length ||
        bytes.toString("base64") !== options.data ||
        checksum(bytes) !== options.sha256
      ) {
        throw new Error("RPC transfer chunk encoding or checksum mismatch");
      }
      this.write(transfer, bytes, transfer.offset);
      transfer.offset += bytes.length;
      return { offset: transfer.offset };
    });
  }
  private async *bytes(
    transfer: Transfer,
    signal: AbortSignal,
  ): AsyncGenerator<Uint8Array> {
    const hash = createHash("sha256");
    for (let offset = 0; offset < transfer.size;) {
      signal.throwIfAborted();
      this.assertCurrent(transfer);
      const bytes = Buffer.allocUnsafe(
        Math.min(RPC_TRANSFER_CHUNK_BYTES, transfer.size - offset),
      );
      const count = readSync(transfer.fd, bytes, 0, bytes.length, offset);
      if (count !== bytes.length) {
        throw new Error("Incomplete RPC transfer file");
      }
      hash.update(bytes);
      offset += count;
      yield bytes;
      await setImmediate(undefined, { signal });
    }
    this.assertCurrent(transfer);
    if (hash.digest("hex") !== transfer.sha256) {
      throw new Error("RPC transfer file checksum mismatch");
    }
  }
  finish(args: Record<string, unknown>) {
    const transfer = this.lookup(RpcTransferBindingSchema.parse(args));
    return this.run(transfer, async () => {
      try {
        this.assertCurrent(transfer);
        if (transfer.offset !== transfer.size) {
          throw new Error("RPC transfer is incomplete");
        }
        if (transfer.kind === "import") {
          if (transfer.hash.copy().digest("hex") !== transfer.sha256) {
            throw new Error("RPC transfer checksum mismatch");
          }
          fsyncSync(transfer.fd);
          transfer.identity = fstatSync(transfer.fd);
          const signal = AbortSignal.any([
            this.signal,
            transfer.controller.signal,
          ]);
          await this.session.importStream(this.bytes(transfer, signal), {
            cwd: transfer.cwd,
            signal,
          });
        }
        return { completed: true, sessionId: this.session.sessionId };
      } finally {
        this.cleanup(transfer);
      }
    });
  }
  cancel(args: Record<string, unknown>) {
    const binding = RpcTransferBindingSchema.parse(args);
    const transfer = this.transfers.get(binding.transferId);
    if (
      transfer?.sessionId !== binding.sessionId ||
      transfer.revision !== binding.revision
    ) {
      return Promise.reject(
        new Error("Unknown or incorrectly bound RPC transfer"),
      );
    }
    return this.cancelOwned(transfer).then(() => ({ cancelled: true }));
  }
  private cleanup(transfer: Transfer): void {
    if (transfer.closed) {
      return;
    }
    transfer.closed = true;
    clearTimeout(transfer.timer);
    this.transfers.delete(transfer.id);
    try {
      this.assertFile(transfer);
      unlinkSync(transfer.path);
      rmdirSync(transfer.directory);
    } finally {
      closeSync(transfer.fd);
    }
  }
  private async cancelOwned(transfer: Transfer): Promise<void> {
    transfer.controller.abort(new Error("RPC transfer cancelled or expired"));
    await transfer.operation?.catch(() => undefined);
    this.cleanup(transfer);
  }
  async invalidate(): Promise<void> {
    await Promise.allSettled(
      [...this.transfers.values()].map((transfer) =>
        this.cancelOwned(transfer),
      ),
    );
  }
  dispose(): Promise<void> {
    this.closing ??= this.invalidate();
    this.signal.removeEventListener("abort", this.aborted);
    return this.closing;
  }
}

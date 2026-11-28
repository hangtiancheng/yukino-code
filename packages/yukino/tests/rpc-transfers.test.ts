import { createHash } from "node:crypto";
import {
  existsSync,
  linkSync,
  mkdirSync,
  readdirSync,
  renameSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  RPC_MAX_LINE_BYTES,
  RPC_TRANSFER_CHUNK_BYTES,
  RPC_TRANSFER_LIMIT,
  RPC_TRANSFER_MAX_BYTES,
  RPC_TRANSFER_TTL_MS,
} from "@/rpc/constants.js";
import { parseRpcRequest } from "@/rpc/protocol.js";
import { RpcServer } from "@/rpc/server.js";
import { RpcTransfers } from "@/rpc/transfers.js";
import { SessionManager } from "@/session/manager.js";

let root: string;
let cwd: string;
const stores: RpcTransfers[] = [];
const hash = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const descriptor = z.object({
  transferId: z.string(),
  sessionId: z.string(),
  revision: z.number(),
  size: z.number(),
  sha256: z.string(),
  chunkBytes: z.number(),
  expiresAt: z.number(),
});
function fixture() {
  let manager = SessionManager.create(cwd, { persist: false });
  const session = {
    get sessionId() {
      return manager.id;
    },
    get sessionManager() {
      return manager;
    },
    cwd,
    isDisposed: false,
    exportStream: vi.fn(
      (options: Parameters<SessionManager["exportStream"]>[0]) =>
        manager.exportStream(options),
    ),
    importStream: vi.fn(
      async (
        source: AsyncIterable<Uint8Array>,
        options: { cwd?: string; signal?: AbortSignal } = {},
      ) => {
        manager = await SessionManager.importStream(
          options.cwd ?? cwd,
          source,
          options,
        );
      },
    ),
  };
  const controller = new AbortController();
  const store = new RpcTransfers(session, controller.signal);
  stores.push(store);
  return { session, store, controller };
}
function binding(value: z.infer<typeof descriptor>) {
  return {
    transferId: value.transferId,
    sessionId: value.sessionId,
    revision: value.revision,
  };
}
async function write(
  store: RpcTransfers,
  transfer: z.infer<typeof descriptor>,
  bytes: Buffer,
) {
  for (
    let offset = 0;
    offset < bytes.length;
    offset += RPC_TRANSFER_CHUNK_BYTES
  ) {
    const chunk = bytes.subarray(offset, offset + RPC_TRANSFER_CHUNK_BYTES);
    await store.writeChunk({
      ...binding(transfer),
      offset,
      length: chunk.length,
      data: chunk.toString("base64"),
      sha256: hash(chunk),
    });
  }
}
beforeEach(() => {
  root = join(homedir(), "private-transfers");
  cwd = join(homedir(), "project");
  mkdirSync(root);
  mkdirSync(cwd);
  vi.stubEnv("TMPDIR", root);
});
afterEach(async () => {
  vi.useRealTimers();
  await Promise.allSettled(stores.splice(0).map((store) => store.dispose()));
  vi.unstubAllEnvs();
});

describe("RPC private bounded pull transfers", () => {
  it.each(["jsonl", "html"] as const)(
    "spools >1MiB %s without the string API and reads only requested bytes",
    async (format) => {
      const { store, session } = fixture();
      session.sessionManager.append({
        role: "user",
        content: "雪<&>".repeat(250_000),
      });
      const small = vi.spyOn(session.sessionManager, "export");
      const transfer = descriptor.parse(
        await store.beginExport({ scope: "tree", format }),
      );
      expect(transfer.size).toBeGreaterThan(RPC_MAX_LINE_BYTES);
      expect(small).not.toHaveBeenCalled();
      const directory = join(root, readdirSync(root)[0]);
      expect(statSync(directory).mode & 0o777).toBe(0o700);
      expect(statSync(join(directory, transfer.transferId)).mode & 0o777).toBe(
        0o600,
      );
      const chunks: Buffer[] = [];
      let offset = 0;
      while (offset < transfer.size) {
        const result = await store.read({
          ...binding(transfer),
          offset,
          length: offset === 0 ? 1 : 65536,
        });
        const bytes = Buffer.from(result.data, "base64");
        expect(bytes.length).toBe(result.length);
        expect(result.sha256).toBe(hash(bytes));
        expect(bytes.length).toBeLessThanOrEqual(65536);
        chunks.push(bytes);
        offset += result.length;
      }
      const result = Buffer.concat(chunks);
      expect(result.length).toBe(transfer.size);
      expect(hash(result)).toBe(transfer.sha256);
      expect(await store.finish(binding(transfer))).toMatchObject({
        completed: true,
      });
      expect(readdirSync(root)).toEqual([]);
    },
  );

  it("imports ordered chunks only after full size/hash and JSONL validation", async () => {
    const { store, session } = fixture();
    const bytes = Buffer.from(
      session.sessionManager.export({ scope: "tree", format: "jsonl" }),
    );
    const before = session.sessionId;
    const transfer = descriptor.parse(
      store.beginImport({ size: bytes.length, sha256: hash(bytes) }),
    );
    expect(session.importStream).not.toHaveBeenCalled();
    await write(store, transfer, bytes);
    expect(session.sessionId).toBe(before);
    await store.finish(binding(transfer));
    expect(session.sessionId).not.toBe(before);
    expect(session.importStream).toHaveBeenCalledOnce();
    expect(readdirSync(root)).toEqual([]);
  });

  it("rejects wrong order, session, revision, noncanonical base64, oversized chunks and checksums without advancing", async () => {
    const { store } = fixture();
    const bytes = Buffer.from("a");
    const transfer = descriptor.parse(
      store.beginImport({ size: 65536, sha256: hash(bytes) }),
    );
    const args = {
      ...binding(transfer),
      offset: 0,
      length: 1,
      data: "YQ==",
      sha256: hash(bytes),
    };
    await expect(store.writeChunk({ ...args, offset: 1 })).rejects.toThrow(
      /offset/,
    );
    expect(() => store.writeChunk({ ...args, sessionId: "wrong" })).toThrow(
      /bound/,
    );
    expect(() =>
      store.writeChunk({ ...args, revision: transfer.revision + 1 }),
    ).toThrow(/bound/);
    await expect(store.writeChunk({ ...args, data: "YR==" })).rejects.toThrow(
      /encoding/,
    );
    await expect(
      store.writeChunk({ ...args, sha256: "0".repeat(64) }),
    ).rejects.toThrow(/checksum/);
    expect(() => store.writeChunk({ ...args, length: 65537 })).toThrow();
    expect(() => store.writeChunk({ ...args, data: "YQ==\n" })).toThrow();
    await expect(store.writeChunk({ ...args, data: "YWE=" })).rejects.toThrow(
      /encoding/,
    );
    const pending = store.writeChunk(args);
    await expect(store.writeChunk(args)).rejects.toThrow(/already pending/);
    await pending;
    await store.cancel(binding(transfer));
    expect(readdirSync(root)).toEqual([]);
  });

  it.each(["incomplete", "hash", "jsonl"])(
    "cleans failed %s finishes without importing",
    async (reason) => {
      const { store, session } = fixture();
      const bytes = Buffer.from("{}\n");
      const transfer = descriptor.parse(
        store.beginImport({
          size: bytes.length,
          sha256: reason === "hash" ? "0".repeat(64) : hash(bytes),
        }),
      );
      const before = session.sessionId;
      if (reason !== "incomplete") {
        await write(store, transfer, bytes);
      }
      await expect(store.finish(binding(transfer))).rejects.toThrow();
      expect(session.sessionId).toBe(before);
      if (reason !== "jsonl") {
        expect(session.importStream).not.toHaveBeenCalled();
      }
      expect(readdirSync(root)).toEqual([]);
    },
  );

  it("bounds total bytes/concurrency, expires once, cancels and cleans on host abort", async () => {
    vi.useFakeTimers();
    const { store, controller } = fixture();
    expect(() =>
      store.beginImport({
        size: RPC_TRANSFER_MAX_BYTES + 1,
        sha256: "0".repeat(64),
      }),
    ).toThrow();
    const transfers = Array.from({ length: RPC_TRANSFER_LIMIT }, () =>
      descriptor.parse(
        store.beginImport({
          size: RPC_TRANSFER_MAX_BYTES,
          sha256: "0".repeat(64),
        }),
      ),
    );
    expect(() =>
      store.beginImport({ size: 1, sha256: "0".repeat(64) }),
    ).toThrow(/concurrent/);
    await store.cancel(binding(transfers[0]));
    expect(readdirSync(root)).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(RPC_TRANSFER_TTL_MS);
    expect(readdirSync(root)).toEqual([]);
    const fresh = descriptor.parse(
      store.beginImport({ size: 1, sha256: "0".repeat(64) }),
    );
    controller.abort();
    await store.dispose();
    expect(readdirSync(root)).toEqual([]);
    await expect(store.cancel(binding(fresh))).rejects.toThrow(/Unknown/);
  });

  it("invalidates a transfer on source mutation or session switch", async () => {
    const { store, session } = fixture();
    const transfer = descriptor.parse(await store.beginExport({}));
    session.sessionManager.setName("new revision");
    expect(() =>
      store.read({ ...binding(transfer), offset: 0, length: 1 }),
    ).toThrow(/revision/);
    await store.invalidate();
    expect(readdirSync(root)).toEqual([]);
  });

  it.each(["symlink", "replacement", "hardlink"])(
    "never deletes foreign %s files during cancellation",
    async (kind) => {
      const { store } = fixture();
      const transfer = descriptor.parse(
        store.beginImport({ size: 1, sha256: "0".repeat(64) }),
      );
      const directory = join(root, readdirSync(root)[0]);
      const path = join(directory, transfer.transferId);
      const foreign = join(root, "foreign");
      writeFileSync(foreign, "foreign data");
      if (kind === "hardlink") {
        linkSync(path, join(root, "extra-link"));
      } else {
        renameSync(path, join(directory, "original"));
        if (kind === "symlink") {
          symlinkSync(foreign, path);
        } else {
          writeFileSync(path, "replacement");
        }
      }
      await expect(store.cancel(binding(transfer))).rejects.toThrow(/Unsafe/);
      expect(existsSync(path)).toBe(true);
      expect(existsSync(foreign)).toBe(true);
    },
  );

  it("keeps status/cancel reachable while a finish waits, and EOF cancels it without queue deadlock", async () => {
    const { store, session, controller } = fixture();
    const bytes = Buffer.from(
      session.sessionManager.export({ scope: "tree", format: "jsonl" }),
    );
    const transfer = descriptor.parse(
      store.beginImport({ size: bytes.length, sha256: hash(bytes) }),
    );
    await write(store, transfer, bytes);
    let waiting!: () => void;
    const started = new Promise<void>((resolve) => {
      waiting = resolve;
    });
    session.importStream.mockImplementationOnce(async (_source, options) => {
      waiting();
      await new Promise<void>((_resolve, reject) =>
        options?.signal?.addEventListener(
          "abort",
          () => {
            reject(new Error("closed"));
          },
          { once: true },
        ),
      );
    });
    const input = new PassThrough();
    const output = new PassThrough();
    const lines: string[] = [];
    output.on("data", (chunk: Buffer) => lines.push(chunk.toString()));
    const server = new RpcServer(
      {
        sessionId: () => session.sessionId,
        subscribe: () => () => undefined,
        handlers: {
          finish_transfer: (args) => store.finish(args),
          get_state: () => ({ alive: true }),
          cancel_transfer: (args) => store.cancel(args),
        },
        abort: () => {
          controller.abort();
          return store.dispose();
        },
        dispose: () => Promise.resolve(),
      },
      output,
    );
    const running = server.run(input);
    const request = (commandId: string, command: string, args = {}) =>
      input.write(
        JSON.stringify({
          version: 1,
          type: "request",
          commandId,
          command,
          args,
        }) + "\n",
      );
    request("finish", "finish_transfer", binding(transfer));
    await started;
    request("status", "get_state");
    await vi.waitFor(() => {
      expect(lines.join("")).toContain('"alive":true');
    });
    input.end();
    await running;
    expect(readdirSync(root)).toEqual([]);
  });

  it("returns an explicit oversized-small-result error without breaking the connection", async () => {
    const output = new PassThrough();
    const lines: string[] = [];
    output.on("data", (chunk: Buffer) => lines.push(chunk.toString()));
    const server = new RpcServer(
      {
        sessionId: () => "fixture",
        subscribe: () => () => undefined,
        handlers: {
          export_session: () => "x".repeat(RPC_MAX_LINE_BYTES + 1),
          get_state: () => "healthy",
        },
        abort: () => undefined,
        dispose: () => Promise.resolve(),
      },
      output,
    );
    server.receive(
      JSON.stringify({
        version: 1,
        type: "request",
        commandId: "large",
        command: "export_session",
        args: {},
      }),
    );
    await vi.waitFor(() => {
      expect(lines.join("")).toContain("result_too_large");
    });
    server.receive(
      JSON.stringify({
        version: 1,
        type: "request",
        commandId: "state",
        command: "get_state",
        args: {},
      }),
    );
    await vi.waitFor(() => {
      expect(lines.join("")).toContain("healthy");
    });
    await server.stop();
  });

  it("validates wire quotas before handlers", () => {
    const request = {
      version: 1,
      type: "request",
      commandId: "test",
      command: "read_transfer_chunk",
      args: {
        transferId: "00000000-0000-4000-8000-000000000000",
        sessionId: "s",
        revision: 0,
        offset: 0,
        length: 65536,
      },
    };
    expect(() => parseRpcRequest(request)).not.toThrow();
    expect(() =>
      parseRpcRequest({ ...request, args: { ...request.args, length: 65537 } }),
    ).toThrow();
  });
});

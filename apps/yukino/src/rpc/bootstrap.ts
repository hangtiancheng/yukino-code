// Bootstrap for the Go agent-bridge binaries that ship alongside the CLI.
//
// All three transports resolve their binary from ~/.yukino/bin using the
// release asset naming yukino-code-<transport>-<os>-<arch>: postinstall.mjs
// downloads them from the fixed GitHub release, and `pnpm build:yukino` in the
// monorepo writes locally built ones to the same directory.
//
// stdio needs no server management here — the stdio client spawns the child
// itself on first use. ws/rpc are server processes: startBridgeServer spawns
// the local binary bound to the transport URL and waits until it listens; the
// App calls ensureBridgeServer once the session's provider is known (a
// remembered default_provider or the user's pick) so the bridge is warm before
// the first prompt. killBridgeServers terminates the spawned servers on exit.

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { connect } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

import type { RemoteTransport } from "./transport.js";

/** Which bridge binary to resolve/spawn. */
export type BridgeTransport = "rpc" | "stdio" | "ws";

/** The bridge transports served by a locally spawned server process. */
export type BridgeServerTransport = Exclude<BridgeTransport, "stdio">;

// stderrTailCap bounds how much server stderr is kept to explain a startup
// failure; startupTimeoutMs is how long the readiness probe retries.
const stderrTailCap = 2048;
const startupTimeoutMs = 10_000;
const pollIntervalMs = 100;
const probeTimeoutMs = 500;

/** Binary/asset name for a transport on this platform. */
export function bridgeBinaryName(transport: BridgeTransport): string {
  return `yukino-code-${transport}-${process.platform}-${process.arch}`;
}

/** Directory bridge binaries are downloaded to and built into. */
export function bridgeBinDir(): string {
  return join(homedir(), ".yukino", "bin");
}

/** Absolute path of the transport's binary when present, else undefined. */
export function resolveBridgeBinary(
  transport: BridgeTransport,
  binDir: string = bridgeBinDir(),
): string | undefined {
  const binPath = join(binDir, bridgeBinaryName(transport));
  return existsSync(binPath) ? binPath : undefined;
}

/** Listen target derived from a transport URL. */
export interface BridgeServerTarget {
  /** Bare hostname for TCP probes (no IPv6 brackets). */
  host: string;
  port: number;
  /** Go -addr value: host:port with IPv6 hosts bracketed. */
  addr: string;
  /** Websocket route for the ws server (-path); absent for rpc. */
  path?: string;
}

/** Parse a ws/rpc transport URL into the server's listen target. */
export function bridgeServerTarget(
  transport: BridgeServerTransport,
  url: string,
): BridgeServerTarget {
  const parsed = new URL(url);
  const port = Number(parsed.port || (transport === "ws" ? 7861 : 7860));
  // Node's URL.hostname keeps the brackets around an IPv6 literal; probes want
  // the bare host while Go's -addr wants it bracketed.
  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  const target: BridgeServerTarget = {
    host,
    port,
    addr: host.includes(":") ? `[${host}]:${port}` : `${host}:${port}`,
  };
  if (transport === "ws" && parsed.pathname && parsed.pathname !== "/") {
    target.path = parsed.pathname;
  }
  return target;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Resolve whether something already listens on host:port. */
function probePort(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    let settled = false;
    const finish = (open: boolean): void => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(probeTimeoutMs);
    socket.once("connect", () => {
      finish(true);
    });
    socket.once("timeout", () => {
      finish(false);
    });
    socket.once("error", () => {
      finish(false);
    });
  });
}

const spawnedServers: ChildProcess[] = [];
let exitHooked = false;

/** Terminate every bridge server spawned by this process; safe to repeat. */
export function killBridgeServers(): void {
  for (const child of spawnedServers) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
    }
  }
}

function registerExitCleanup(): void {
  if (exitHooked) {
    return;
  }
  exitHooked = true;
  // Last-resort cleanup for exit paths that bypass main()'s handlers; the
  // child also shares the terminal's process group, so Ctrl+C reaches it too.
  process.on("exit", killBridgeServers);
}

/**
 * Spawn the local bridge server for a ws/rpc transport URL and wait until it
 * listens. Throws when the binary is missing, the address is already taken, or
 * the child dies or stalls during startup.
 */
export async function startBridgeServer(
  transport: BridgeServerTransport,
  url: string,
): Promise<void> {
  const name = bridgeBinaryName(transport);
  const binPath = resolveBridgeBinary(transport);
  if (!binPath) {
    throw new Error(
      `${name} not found (expected in ${bridgeBinDir()}) — reinstall @yukino.js/yukino, or run "pnpm build:yukino:${transport}" inside the repo`,
    );
  }
  const { host, port, addr, path: wsPath } = bridgeServerTarget(transport, url);
  if (await probePort(host, port)) {
    throw new Error(`cannot start ${name}: ${addr} is already in use`);
  }

  const args = ["-addr", addr];
  if (wsPath) {
    args.push("-path", wsPath);
  }
  const child = spawn(binPath, args, { stdio: ["ignore", "ignore", "pipe"] });
  spawnedServers.push(child);
  registerExitCleanup();

  let stderrTail = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderrTail = (stderrTail + chunk).slice(-stderrTailCap);
  });

  const deadline = Date.now() + startupTimeoutMs;
  for (;;) {
    if (child.exitCode !== null || child.signalCode !== null) {
      const detail = stderrTail.trim();
      throw new Error(
        `${name} exited during startup (code ${child.exitCode ?? child.signalCode})${detail ? `: ${detail}` : ""}`,
      );
    }
    if (await probePort(host, port)) {
      return;
    }
    if (Date.now() > deadline) {
      child.kill("SIGTERM");
      throw new Error(
        `${name} did not start listening on ${addr} within ${startupTimeoutMs / 1000}s`,
      );
    }
    await delay(pollIntervalMs);
  }
}

let ensurePromise: Promise<void> | null = null;

/**
 * Idempotent bridge bootstrap driven by the UI: stdio needs no server (the
 * client spawns the child itself), ws/rpc spawn the local binary once — the
 * first time the session actually needs the bridge. A failed start clears the
 * memo so a later attempt can retry.
 */
export function ensureBridgeServer(remote: RemoteTransport): Promise<void> {
  if (remote.kind === "stdio") {
    return Promise.resolve();
  }
  ensurePromise ??= startBridgeServer(
    remote.kind === "connect" ? "rpc" : "ws",
    remote.url,
  ).catch((err: unknown) => {
    ensurePromise = null;
    throw err;
  });
  return ensurePromise;
}

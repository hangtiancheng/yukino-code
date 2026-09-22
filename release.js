// @ts-check
"use strict";

/**
 * Build and release the Go agent-bridge binaries.
 *
 * The bridge ships as one binary per transport the terminal UI can drive:
 *
 *   - rpc:   Connect (protobuf RPC) over HTTP        (yukino/cmd/yukino-code-rpc)
 *   - stdio: JSON-RPC 2.0 over a spawned child       (yukino/cmd/yukino-code-stdio)
 *   - ws:    JSON-RPC 2.0 over a websocket           (yukino/cmd/yukino-code-ws)
 *
 * Each transport is cross-compiled for {linux,darwin,win32} x {x64,arm64} and
 * named yukino-code-<transport>-<os>-<arch> (18 assets).
 *
 * CLI usage:
 *   node release.js build [rpc|stdio|ws]  build for the current platform into ~/.yukino/bin
 *   node release.js dev <rpc|stdio|ws>    go run one server in the foreground
 *   node release.js [release]             cross-compile every target and upload to the GitHub release
 *
 * The release lives at a fixed tag (no version number); every publish deletes
 * the previous same-named assets and uploads fresh ones. Requires GITHUB_TOKEN.
 * Override the tag with YUKINO_RELEASE_TAG.
 */

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT_DIR = path.dirname(fileURLToPath(import.meta.url));
const YUKINO_DIR = path.join(ROOT_DIR, "yukino");
/** Where the CLI resolves bridge binaries from (postinstall downloads here too). */
const BIN_DIR = path.join(homedir(), ".yukino", "bin");
/** Staging directory for the cross-compiled release assets. */
const DIST_DIR = path.join(ROOT_DIR, "dist", "release");

const REPO = "hangtiancheng/yukino-code";
const RELEASE_TAG = process.env.YUKINO_RELEASE_TAG || "binaries";
const RELEASE_NAME = "yukino-code bridge binaries";
const RELEASE_BODY =
  "Prebuilt Go agent-bridge binaries, downloaded by the @yukino.js/yukino postinstall step into ~/.yukino/bin. Every publish overwrites the previous assets.";

const GITHUB_API = "https://api.github.com";
const GITHUB_UPLOADS = "https://uploads.github.com";
const UPLOAD_CONCURRENCY = 4;

/** @typedef {"rpc" | "stdio" | "ws"} Transport */
/**
 * Release target. os/arch use Node naming (process.platform / process.arch) so
 * binary names match what postinstall.mjs and the CLI resolve at runtime.
 * @typedef {{
 *   os: "linux" | "darwin" | "win32",
 *   arch: "x64" | "arm64",
 *   goos: "linux" | "darwin" | "windows",
 *   goarch: "amd64" | "arm64",
 * }} Target
 */

/** @type {Transport[]} */
const TRANSPORTS = ["rpc", "stdio", "ws"];

/** Release matrix. @type {Target[]} */
const TARGETS = [
  { os: "linux", arch: "x64", goos: "linux", goarch: "amd64" },
  { os: "linux", arch: "arm64", goos: "linux", goarch: "arm64" },
  { os: "darwin", arch: "x64", goos: "darwin", goarch: "amd64" },
  { os: "darwin", arch: "arm64", goos: "darwin", goarch: "arm64" },
  { os: "win32", arch: "x64", goos: "windows", goarch: "amd64" },
  { os: "win32", arch: "arm64", goos: "windows", goarch: "arm64" },
];

/**
 * @param {Transport} transport
 * @param {Target} target
 */
function binaryName(transport, target) {
  return `yukino-code-${transport}-${target.os}-${target.arch}`;
}

/**
 * @param {string | undefined} arg
 * @returns {Transport | undefined}
 */
function parseTransport(arg) {
  if (arg === undefined) return undefined;
  if (!TRANSPORTS.includes(/** @type {Transport} */ (arg))) {
    fail(`unknown transport "${arg}" (expected one of: ${TRANSPORTS.join(", ")})`);
  }
  return /** @type {Transport} */ (arg);
}

/**
 * @param {string} message
 * @returns {never}
 */
function fail(message) {
  console.error(`release.js: ${message}`);
  process.exit(1);
}

/** @returns {Target} */
function currentTarget() {
  const target = TARGETS.find(
    (t) => t.os === process.platform && t.arch === process.arch,
  );
  if (!target) {
    fail(`unsupported platform: ${process.platform}-${process.arch}`);
  }
  return target;
}

/**
 * Run one `go build` for a transport/target pair.
 * @param {Transport} transport
 * @param {Target} target
 * @param {string} outFile
 * @returns {Promise<void>}
 */
function goBuild(transport, target, outFile) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    const child = spawn(
      "go",
      [
        "build",
        "-trimpath",
        "-ldflags",
        "-s -w",
        "-o",
        outFile,
        `./cmd/yukino-code-${transport}`,
      ],
      {
        cwd: YUKINO_DIR,
        env: {
          ...process.env,
          GOOS: target.goos,
          GOARCH: target.goarch,
          CGO_ENABLED: "0",
        },
        stdio: ["ignore", "inherit", "inherit"],
      },
    );
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve(undefined);
      } else {
        reject(
          new Error(
            `go build ${binaryName(transport, target)} failed (exit ${code})`,
          ),
        );
      }
    });
  });
}

/**
 * Map over items with a bounded concurrency pool, preserving result order.
 * @template T, R
 * @param {T[]} items
 * @param {number} limit
 * @param {(item: T, index: number) => Promise<R>} fn
 * @returns {Promise<R[]>}
 */
async function mapPool(items, limit, fn) {
  /** @type {R[]} */
  const results = [];
  let next = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      for (;;) {
        const index = next++;
        if (index >= items.length) return;
        results[index] = await fn(items[index], index);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

/** @returns {string} */
function githubToken() {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    fail("GITHUB_TOKEN environment variable is required to publish the release");
  }
  return token;
}

/**
 * @param {string} url
 * @param {string} token
 * @param {RequestInit & { headers?: Record<string, string> }} [init]
 */
async function github(url, token, init = {}) {
  return fetch(url, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "User-Agent": "yukino-code-release",
      ...init.headers,
    },
  });
}

/**
 * Build binaries for the current platform into ~/.yukino/bin.
 * @param {Transport | undefined} transportArg
 */
async function build(transportArg) {
  const transports = transportArg ? [transportArg] : TRANSPORTS;
  const target = currentTarget();
  fs.mkdirSync(BIN_DIR, { recursive: true });
  await Promise.all(
    transports.map(async (transport) => {
      const outFile = path.join(BIN_DIR, binaryName(transport, target));
      await goBuild(transport, target, outFile);
      console.log(`built ${outFile}`);
    }),
  );
}

/**
 * Run one server with `go run` in the foreground.
 * @param {Transport | undefined} transport
 */
function dev(transport) {
  if (!transport) {
    fail("dev requires a transport: node release.js dev <rpc|stdio|ws>");
  }
  const result = spawnSync("go", ["run", `./cmd/yukino-code-${transport}`], {
    cwd: YUKINO_DIR,
    stdio: "inherit",
  });
  if (result.error) {
    fail(String(result.error));
  }
  process.exitCode = result.status ?? 1;
}

/** Cross-compile all 18 targets and (re)upload them to the fixed-tag release. */
async function release() {
  const token = githubToken();

  /** @type {{ name: string, file: string, transport: Transport, target: Target }[]} */
  const jobs = [];
  for (const transport of TRANSPORTS) {
    for (const target of TARGETS) {
      const name = binaryName(transport, target);
      jobs.push({ name, file: path.join(DIST_DIR, name), transport, target });
    }
  }

  fs.rmSync(DIST_DIR, { recursive: true, force: true });
  console.log(`cross-compiling ${jobs.length} binaries into ${DIST_DIR} …`);
  await Promise.all(
    jobs.map(async (job) => {
      await goBuild(job.transport, job.target, job.file);
      console.log(`built ${job.name}`);
    }),
  );

  // Find or create the fixed-tag release.
  /** @type {number} */
  let releaseId;
  const existing = await github(
    `${GITHUB_API}/repos/${REPO}/releases/tags/${RELEASE_TAG}`,
    token,
  );
  if (existing.ok) {
    releaseId = /** @type {{ id: number }} */ (await existing.json()).id;
  } else if (existing.status === 404) {
    const created = await github(`${GITHUB_API}/repos/${REPO}/releases`, token, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tag_name: RELEASE_TAG,
        name: RELEASE_NAME,
        body: RELEASE_BODY,
      }),
    });
    if (!created.ok) {
      fail(`create release failed: ${created.status} ${await created.text()}`);
    }
    releaseId = /** @type {{ id: number }} */ (await created.json()).id;
  } else {
    fail(`lookup release failed: ${existing.status} ${await existing.text()}`);
  }

  // Overwrite semantics: drop same-named assets first, then upload fresh ones.
  const assetsRes = await github(
    `${GITHUB_API}/repos/${REPO}/releases/${releaseId}/assets?per_page=100`,
    token,
  );
  if (!assetsRes.ok) {
    fail(`list assets failed: ${assetsRes.status} ${await assetsRes.text()}`);
  }
  /** @type {{ id: number, name: string }[]} */
  const assets = await assetsRes.json();
  for (const asset of assets) {
    if (!jobs.some((job) => job.name === asset.name)) continue;
    const del = await github(
      `${GITHUB_API}/repos/${REPO}/releases/assets/${asset.id}`,
      token,
      { method: "DELETE" },
    );
    if (!del.ok && del.status !== 404) {
      fail(`delete asset ${asset.name} failed: ${del.status} ${await del.text()}`);
    }
  }

  await mapPool(jobs, UPLOAD_CONCURRENCY, async (job) => {
    const body = fs.readFileSync(job.file);
    const upload = await github(
      `${GITHUB_UPLOADS}/repos/${REPO}/releases/${releaseId}/assets?name=${encodeURIComponent(job.name)}`,
      token,
      {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body,
      },
    );
    if (!upload.ok) {
      fail(`upload ${job.name} failed: ${upload.status} ${await upload.text()}`);
    }
    console.log(`uploaded ${job.name}`);
  });

  console.log(`released ${jobs.length} binaries to ${REPO}@${RELEASE_TAG}`);
}

async function main() {
  const [command = "release", arg] = process.argv.slice(2);
  switch (command) {
    case "build":
      await build(parseTransport(arg));
      break;
    case "dev":
      dev(parseTransport(arg));
      break;
    case "release":
      await release();
      break;
    default:
      fail(`unknown command "${command}" (expected: build | dev | release)`);
  }
}

main().catch((err) => {
  console.error(`release.js: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  process.exitCode = 1;
});

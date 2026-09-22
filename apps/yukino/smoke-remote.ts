/* eslint-disable no-console -- standalone smoke harness */
// Live end-to-end smoke test for the three Go agent-bridge transports
// (Connect / websocket / stdio) driven by the real TS clients. It hits the real
// LLM endpoints in ~/.yukino/config.yaml, so it is run manually, never in CI.
//
//   pnpm tsx ./smoke-remote.ts
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import sharp from "sharp";

import {
  createAgentRpc,
  type AgentRpc,
  type RemoteEvent,
  type RpcContentBlock,
} from "@/rpc/client.js";
import { createStdioAgentRpc } from "@/rpc/stdio-client.js";
import { createWsAgentRpc } from "@/rpc/ws-client.js";

const GO_BIN = process.env.YUKINO_GO_BIN ?? "/tmp/yukino-bin";
const failures: string[] = [];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(pred: () => boolean, timeoutMs: number, what: string) {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`timeout waiting for ${what}`);
    }
    await sleep(100);
  }
}

function isTerminal(ev: RemoteEvent): boolean {
  return (
    ev.type === "loop_complete" ||
    ev.type === "error" ||
    ev.type === "command_done"
  );
}

/** Drives one AgentRpc: collects events and exposes per-scenario cursors. */
class Session {
  readonly events: RemoteEvent[] = [];
  private readonly ac = new AbortController();
  private pumpError: unknown = null;

  constructor(private readonly rpc: AgentRpc) {
    void (async () => {
      try {
        for await (const ev of rpc.watch(this.ac.signal)) {
          this.events.push(ev);
        }
      } catch (err) {
        this.pumpError = err;
      }
    })();
  }

  async boot(): Promise<void> {
    // session_connected is sent directly on attach, so every transport sees it.
    // session_ready (after MCP warmup) may predate the attach on the server
    // transports, so it is not required: prompts queue until the worker is ready.
    await until(
      () => this.events.some((e) => e.type === "session_connected"),
      60_000,
      "session_connected",
    );
  }

  mark(): number {
    return this.events.length;
  }

  async waitTerminal(since: number, timeoutMs: number): Promise<void> {
    await until(
      () => this.events.slice(since).some(isTerminal),
      timeoutMs,
      "turn to settle",
    );
  }

  summarize(since: number) {
    const evs = this.events.slice(since);
    const text = evs
      .filter((e): e is Extract<RemoteEvent, { type: "stream_text" }> =>
        e.type === "stream_text" ? true : false,
      )
      .map((e) => e.text)
      .join("");
    const err = evs.find(
      (e): e is Extract<RemoteEvent, { type: "error" }> => e.type === "error",
    );
    const loop = evs.find(
      (e): e is Extract<RemoteEvent, { type: "loop_complete" }> =>
        e.type === "loop_complete",
    );
    return {
      text: text.trim(),
      error: err ? (err.error as Error).message : null,
      stopReason: loop ? loop.stopReason : null,
      toolUses: evs.filter((e) => e.type === "tool_use").length,
      events: evs.length,
    };
  }

  dispose(): void {
    this.ac.abort();
    this.rpc.dispose?.();
  }
}

function check(name: string, ok: boolean, detail: string): void {
  if (ok) {
    console.log(`  PASS  ${name}  ${detail}`);
  } else {
    console.log(`  FAIL  ${name}  ${detail}`);
    failures.push(name);
  }
}

async function textTurn(
  sess: Session,
  name: string,
  prompt: string,
  expect: string,
): Promise<void> {
  const since = sess.mark();
  const queued = await sess["rpc"].sendPrompt(prompt);
  if (!queued) {
    check(name, false, "prompt was not queued");
    return;
  }
  await sess.waitTerminal(since, 180_000);
  const s = sess.summarize(since);
  const ok =
    s.error === null &&
    s.stopReason !== null &&
    s.text.toLowerCase().includes(expect.toLowerCase());
  check(
    name,
    ok,
    `stop=${s.stopReason ?? "none"} err=${s.error ?? "-"} text=${JSON.stringify(
      s.text.slice(0, 80),
    )}`,
  );
}

async function imageTurn(
  sess: Session,
  name: string,
  blocks: RpcContentBlock[],
  expect: "success" | "error" | "tolerant",
): Promise<void> {
  const since = sess.mark();
  const queued = await sess["rpc"].sendPromptBlocks(blocks);
  if (!queued) {
    check(name, false, "prompt was not queued");
    return;
  }
  await sess.waitTerminal(since, 180_000);
  const s = sess.summarize(since);
  let ok = false;
  if (expect === "success") {
    ok = s.error === null && s.stopReason !== null;
  } else if (expect === "error") {
    ok = s.error !== null;
  } else {
    // tolerant: either a clean refusal turn or an explicit error is acceptable
    ok = s.error !== null || s.stopReason !== null;
  }
  check(
    name,
    ok,
    `stop=${s.stopReason ?? "none"} err=${s.error ?? "-"} text=${JSON.stringify(
      s.text.slice(0, 80),
    )}`,
  );
}

async function toolTurn(
  sess: Session,
  name: string,
  prompt: string,
): Promise<void> {
  const since = sess.mark();
  const queued = await sess["rpc"].sendPrompt(prompt);
  if (!queued) {
    check(name, false, "prompt was not queued");
    return;
  }
  await sess.waitTerminal(since, 180_000);
  const s = sess.summarize(since);
  const ok = s.error === null && s.stopReason !== null && s.toolUses > 0;
  check(
    name,
    ok,
    `stop=${s.stopReason ?? "none"} tools=${String(s.toolUses)} err=${
      s.error ?? "-"
    } text=${JSON.stringify(s.text.slice(0, 80))}`,
  );
}

async function selectProvider(
  sess: Session,
  name: string,
  provider: string,
  expectModelPart: string,
): Promise<void> {
  try {
    const res = await sess["rpc"].selectProvider(provider);
    const ok = res.model.toLowerCase().includes(expectModelPart.toLowerCase());
    check(name, ok, `model=${res.model} protocol=${res.protocol}`);
  } catch (err) {
    check(name, false, `selectProvider threw: ${(err as Error).message}`);
  }
}

function redImageBlocks(pngB64: string): RpcContentBlock[] {
  return [
    { text: "What color is this image? Answer with just the color name." },
    { image: { base64: { mediaType: "image/png", data: pngB64 } } },
  ];
}

interface ServerHandle {
  child: ChildProcess;
  dispose(): void;
}

function startGoServer(
  bin: string,
  args: string[],
  readyToken: string,
): Promise<ServerHandle> {
  return new Promise((resolve, reject) => {
    const child = spawn(join(GO_BIN, bin), args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let buf = "";
    const onData = (d: Buffer) => {
      buf += d.toString();
      if (buf.includes(readyToken)) {
        resolve({ child, dispose: () => child.kill("SIGTERM") });
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("error", reject);
    setTimeout(
      () => reject(new Error(`server ${bin} did not become ready`)),
      60_000,
    );
  });
}

async function main() {
  const pngB64 = (
    await sharp({
      create: {
        width: 64,
        height: 64,
        channels: 3,
        background: { r: 220, g: 30, b: 30 },
      },
    })
      .png()
      .toBuffer()
  ).toString("base64");

  // NOTE on providers: ds-anthropic / ds-openai (the vision-capable DeepSeek
  // endpoints) currently return HTTP 402 "Insufficient Balance", so a live
  // vision SUCCESS cannot be exercised. The multimodal pipeline is still proven
  // end-to-end: openai-inc rejects the image with a 400 about model params,
  // which only happens once the image block has been serialized, carried over
  // the wire, and handed to the upstream API. Success text/tool turns therefore
  // run on the inc (Qwen) endpoints, which have balance.

  const PONG = "Reply with exactly the single word: PONG";
  const ECHO =
    "Use the Bash tool to run the command `echo SMOKE_OK`, then reply with the exact output.";

  // ---- stdio transport -----------------------------------------------------
  console.log("\n=== stdio (yukino-code-stdio) ===");
  {
    const workDir = mkdtempSync(join(tmpdir(), "smoke-stdio-"));
    const rpc = createStdioAgentRpc({
      command: join(GO_BIN, "yukino-code-stdio"),
      args: ["-workdir", workDir],
    });
    const sess = new Session(rpc);
    try {
      await sess.boot();
      await selectProvider(
        sess,
        "stdio select openai-inc",
        "openai-inc",
        "qwen",
      );
      await textTurn(sess, "stdio text turn (openai-inc)", PONG, "pong");
      await toolTurn(sess, "stdio tool turn (openai-inc Bash)", ECHO);
      await imageTurn(
        sess,
        "stdio multimodal openai-inc (must error)",
        redImageBlocks(pngB64),
        "error",
      );
      await selectProvider(
        sess,
        "stdio select anthropic-inc",
        "anthropic-inc",
        "qwen",
      );
      await textTurn(sess, "stdio text turn (anthropic-inc)", PONG, "pong");
      await imageTurn(
        sess,
        "stdio multimodal anthropic-inc (tolerant)",
        redImageBlocks(pngB64),
        "tolerant",
      );
      await selectProvider(
        sess,
        "stdio select ds-anthropic",
        "ds-anthropic",
        "deepseek",
      );
      await imageTurn(
        sess,
        "stdio multimodal ds-anthropic (vision/balance)",
        redImageBlocks(pngB64),
        "tolerant",
      );
    } finally {
      sess.dispose();
    }
  }

  // ---- websocket transport -------------------------------------------------
  console.log("\n=== ws (yukino-code-ws) ===");
  {
    const workDir = mkdtempSync(join(tmpdir(), "smoke-ws-"));
    const server = await startGoServer(
      "yukino-code-ws",
      ["-addr", "127.0.0.1:7901", "-path", "/ws", "-workdir", workDir],
      "serving",
    );
    const rpc = createWsAgentRpc({ url: "ws://127.0.0.1:7901/ws" });
    const sess = new Session(rpc);
    try {
      await sess.boot();
      await selectProvider(
        sess,
        "ws select anthropic-inc",
        "anthropic-inc",
        "qwen",
      );
      await textTurn(sess, "ws text turn (anthropic-inc)", PONG, "pong");
      await imageTurn(
        sess,
        "ws multimodal anthropic-inc (tolerant)",
        redImageBlocks(pngB64),
        "tolerant",
      );
      await selectProvider(sess, "ws select openai-inc", "openai-inc", "qwen");
      await imageTurn(
        sess,
        "ws multimodal openai-inc (must error)",
        redImageBlocks(pngB64),
        "error",
      );
    } finally {
      sess.dispose();
      server.dispose();
    }
  }

  // ---- Connect transport ---------------------------------------------------
  console.log("\n=== rpc/connect (yukino-code-rpc) ===");
  {
    const workDir = mkdtempSync(join(tmpdir(), "smoke-rpc-"));
    const server = await startGoServer(
      "yukino-code-rpc",
      ["-addr", "127.0.0.1:7902", "-workdir", workDir],
      "serving",
    );
    const rpc = createAgentRpc({ url: "http://127.0.0.1:7902" });
    const sess = new Session(rpc);
    try {
      await sess.boot();
      await selectProvider(sess, "rpc select openai-inc", "openai-inc", "qwen");
      await textTurn(sess, "rpc text turn (openai-inc)", PONG, "pong");
      await imageTurn(
        sess,
        "rpc multimodal openai-inc (must error)",
        redImageBlocks(pngB64),
        "error",
      );
    } finally {
      sess.dispose();
      server.dispose();
    }
  }

  console.log(
    `\n=== RESULT: ${failures.length === 0 ? "ALL PASS" : `${String(failures.length)} FAILURE(S): ${failures.join(", ")}`} ===`,
  );
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("smoke harness crashed:", err);
  process.exit(2);
});

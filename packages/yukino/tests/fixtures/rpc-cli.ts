import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import { RpcMessageSchema, type RpcMessage } from "@/rpc/protocol.js";

const ProviderRequestSchema = z.object({
  messages: z.array(z.object({ role: z.string(), content: z.unknown() })),
});
export type ProviderRequest = z.infer<typeof ProviderRequestSchema>;
export type ProviderHandler = (
  request: ProviderRequest,
  response: ServerResponse,
  number: number,
) => void | Promise<void>;

export function reply(response: ServerResponse, delta: object): void {
  response.writeHead(200, { "content-type": "text/event-stream" });
  const chunk = (value: object) =>
    `data: ${JSON.stringify({ id: "local", object: "chat.completion.chunk", created: 1, model: "local", ...value })}\n\n`;
  response.write(
    chunk({ choices: [{ index: 0, delta, finish_reason: null }] }),
  );
  response.write(
    chunk({
      choices: [
        {
          index: 0,
          delta: {},
          finish_reason: "tool_calls" in delta ? "tool_calls" : "stop",
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
    }),
  );
  response.end("data: [DONE]\n\n");
}

export function toolReply(
  response: ServerResponse,
  name: string,
  args: object,
  id = "local-tool",
): void {
  reply(response, {
    role: "assistant",
    tool_calls: [
      {
        index: 0,
        id,
        type: "function",
        function: { name, arguments: JSON.stringify(args) },
      },
    ],
  });
}

export async function rpcCli(
  handler: ProviderHandler = (_request, response) => {
    reply(response, { role: "assistant", content: "RPC_LOCAL_OK" });
  },
  options: {
    args?: string[];
    config?: Record<string, unknown>;
    projectConfig?: Record<string, unknown>;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "yukino-rpc-cli-"));
  const home = join(root, "home");
  const cwd = join(root, "project");
  const requests: ProviderRequest[] = [];
  const providerErrors: Error[] = [];
  const provider = createServer((request, response) => {
    void (async () => {
      assert.equal(request.url, "/v1/chat/completions");
      let body = "";
      request.setEncoding("utf8");
      for await (const chunk of request) {
        body += String(chunk);
        assert.ok(Buffer.byteLength(body) <= 2 * 1024 * 1024);
      }
      const raw: unknown = JSON.parse(body);
      const parsed = ProviderRequestSchema.parse(raw);
      requests.push(parsed);
      await handler(parsed, response, requests.length);
    })().catch((error: unknown) => {
      providerErrors.push(
        error instanceof Error ? error : new Error(String(error)),
      );
      response.writeHead(500);
      response.end("Local fixture failed");
    });
  });
  await mkdir(home);
  await mkdir(cwd);
  provider.listen(0, "127.0.0.1");
  await once(provider, "listening");
  const address = provider.address();
  if (!address || typeof address === "string") {
    throw new Error("Missing local provider address");
  }
  const configPath = join(home, "config.json");
  const credential = "rpc-local-fixture-only-not-a-real-key";
  await writeFile(
    configPath,
    JSON.stringify({
      providers: [
        {
          name: "local",
          protocol: "openai-compat",
          model: "local",
          api_key: credential,
          base_url: `http://127.0.0.1:${address.port}/v1`,
          thinking: "off",
        },
      ],
      enable_memory: false,
      ...options.config,
    }),
  );
  if (options.projectConfig) {
    await mkdir(join(cwd, ".yukino"));
    await writeFile(
      join(cwd, ".yukino", "config.yaml"),
      JSON.stringify(options.projectConfig),
    );
  }
  const built = fileURLToPath(new URL("../../dist/main.js", import.meta.url));
  const source =
    process.env.YUKINO_RPC_CLI_SOURCE === "1" || !existsSync(built);
  const entry = source
    ? [
        "--import",
        fileURLToPath(import.meta.resolve("tsx")),
        fileURLToPath(new URL("../../src/cli.ts", import.meta.url)),
      ]
    : [built];
  const child = spawn(
    process.execPath,
    [
      ...entry,
      "--rpc",
      "--config",
      configPath,
      "--no-persist",
      ...(options.args ?? ["--no-project-resources", "--no-tools"]),
    ],
    {
      cwd,
      env: {
        PATH: process.env.PATH,
        HOME: home,
        TMPDIR: root,
        TSX_TSCONFIG_PATH: fileURLToPath(
          new URL("../../tsconfig.json", import.meta.url),
        ),
        NO_COLOR: "1",
        OTEL_SDK_DISABLED: "true",
        OTEL_TRACES_EXPORTER: "none",
        OTEL_LOGS_EXPORTER: "none",
        OTEL_METRICS_EXPORTER: "none",
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const messages: RpcMessage[] = [];
  const watchers = new Set<{
    predicate: (message: RpcMessage) => boolean;
    resolve: (message: RpcMessage) => void;
    reject: (error: Error) => void;
  }>();
  let errors = "";
  let failure: Error | undefined;
  let buffer = "";
  let ended = false;
  const decoder = new StringDecoder("utf8");
  const fail = (error: Error): void => {
    failure ??= error;
    for (const watcher of watchers) {
      watcher.reject(error);
    }
  };
  child.stdin.on("error", (error) => {
    fail(error);
  });
  child.on("error", (error) => {
    fail(error);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    errors += chunk.toString();
    if (errors.length > 64 * 1024) {
      fail(new Error("CLI stderr exceeded fixture limit"));
    }
  });
  child.stdout.on("data", (chunk: Buffer) => {
    buffer += decoder.write(chunk);
    let end: number;
    while ((end = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      try {
        const raw: unknown = JSON.parse(line);
        const message = RpcMessageSchema.parse(raw);
        assert.ok(
          !line.includes(credential),
          "Credential leaked to RPC stdout",
        );
        messages.push(message);
        for (const watcher of [...watchers]) {
          if (watcher.predicate(message)) {
            watcher.resolve(message);
          }
        }
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    }
  });
  const closed = new Promise<{ code: number | null; signal: string | null }>(
    (resolve) => {
      child.once("close", (code, signal) => {
        ended = true;
        buffer += decoder.end();
        if (buffer) {
          fail(new Error("CLI left an incomplete JSONL output frame"));
        }
        for (const watcher of [...watchers]) {
          watcher.reject(
            new Error(`CLI closed (${code ?? signal}): ${errors}`),
          );
        }
        resolve({ code, signal });
      });
    },
  );
  const deadline = setTimeout(() => {
    fail(new Error(`RPC CLI fixture deadline exceeded: ${errors}`));
    child.kill("SIGKILL");
  }, 25_000);
  const next = (predicate: (message: RpcMessage) => boolean, from = 0) =>
    new Promise<RpcMessage>((resolve, reject) => {
      if (failure) {
        reject(failure);
        return;
      }
      const previous = messages.slice(from).find(predicate);
      if (previous) {
        resolve(previous);
        return;
      }
      if (ended) {
        reject(new Error(`CLI already closed: ${errors}`));
        return;
      }
      const cleanup = (): void => {
        clearTimeout(timer);
        watchers.delete(watcher);
      };
      const watcher = {
        predicate,
        resolve: (message: RpcMessage) => {
          cleanup();
          resolve(message);
        },
        reject: (error: Error) => {
          cleanup();
          reject(error);
        },
      };
      const timer = setTimeout(() => {
        watcher.reject(
          new Error(
            `RPC message deadline exceeded: ${errors}\nProvider errors: ${providerErrors.map((error) => error.message).join("; ")}\nRecent messages: ${JSON.stringify(messages.slice(-8))}`,
          ),
        );
      }, 10_000);
      watchers.add(watcher);
    });
  let number = 0;
  const send = (
    command: string,
    args: object = {},
    commandId = `rpc-${number++}`,
  ): string => {
    child.stdin.write(
      JSON.stringify({
        version: 1,
        type: "request",
        commandId,
        command,
        args,
      }) + "\n",
    );
    return commandId;
  };
  const query = async (
    command: string,
    args: object = {},
  ): Promise<unknown> => {
    const commandId = send(command, args);
    const response = await next(
      (message) =>
        message.type === "response" && message.commandId === commandId,
    );
    assert.equal(response.type, "response");
    if (response.type !== "response" || !response.success) {
      throw new Error(JSON.stringify(response));
    }
    return response.result;
  };
  return {
    child,
    home,
    cwd,
    messages,
    requests,
    next,
    send,
    query,
    closed,
    source,
    stderr: () => errors,
    assertClean: () => {
      assert.equal(failure, undefined);
      assert.deepEqual(providerErrors, []);
      const sequences = messages.flatMap((message) =>
        message.type === "event" ? [message.sequence] : [],
      );
      assert.deepEqual(
        sequences,
        sequences.map((_sequence, index) => index + 1),
      );
    },
    dispose: async () => {
      try {
        if (!ended) {
          child.stdin.end();
          const kill = setTimeout(() => child.kill("SIGKILL"), 2000);
          try {
            await closed;
          } finally {
            clearTimeout(kill);
          }
        }
      } finally {
        clearTimeout(deadline);
        provider.closeAllConnections();
        await new Promise<void>((resolve) =>
          provider.close(() => {
            resolve();
          }),
        );
        await rm(root, { recursive: true, force: true });
      }
    },
  };
}

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

const RequestSchema = z.object({
  tools: z
    .array(z.object({ function: z.object({ name: z.string() }) }))
    .optional(),
  messages: z.array(z.object({ role: z.string(), content: z.unknown() })),
});
const previousHome = process.env.HOME;
const root = await mkdtemp(join(tmpdir(), "yukino-code-mode-cli-"));
process.env.HOME = root;
const entry = fileURLToPath(new URL("../../dist/main.js", import.meta.url));
let scenario = "enabled";
let requests = 0;
const server = createServer((request, response) => {
  let bodyText = "";
  request.setEncoding("utf8");
  request.on("data", (chunk) => {
    bodyText += String(chunk);
  });
  request.on("end", () => {
    const raw = JSON.parse(bodyText);
    const body = RequestSchema.parse(raw);
    const available =
      body.tools?.some((tool) => tool.function.name === "CodeMode") ?? false;
    assert.equal(available, scenario !== "disabled");
    const results = body.messages.filter((message) => message.role === "tool");
    const delta =
      scenario !== "disabled" && results.length === 0
        ? {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: "code-mode-cli",
                type: "function",
                function: {
                  name: "CodeMode",
                  arguments: JSON.stringify({
                    code:
                      scenario === "blocked"
                        ? "await tools.CodeMode({code:'return 1'});"
                        : 'const input = await tools.ReadFile({file_path:"input.txt"}); await tools.WriteFile({file_path:"output.txt",content:input.output}); return "CODE_MODE_OK";',
                  }),
                },
              },
            ],
          }
        : {
            role: "assistant",
            content:
              scenario === "disabled"
                ? "CLI_CODE_MODE_DISABLED"
                : scenario === "blocked"
                  ? "CLI_CODE_MODE_BLOCKED"
                  : "CLI_CODE_MODE_OK",
          };
    if (results.length) {
      const text = results.map((message) => String(message.content)).join("\n");
      assert.ok(
        text.includes(
          scenario === "blocked" ? "Script failed" : "CODE_MODE_OK",
        ),
        text,
      );
    }
    requests++;
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(
      `data: ${JSON.stringify({ id: "local", object: "chat.completion.chunk", created: 1, model: "local", choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`,
    );
    response.write(
      `data: ${JSON.stringify({ id: "local", object: "chat.completion.chunk", created: 1, model: "local", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" in delta ? "tool_calls" : "stop" }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } })}\n\n`,
    );
    response.end("data: [DONE]\n\n");
  });
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const address = server.address();
if (!address || typeof address === "string")
  throw new Error("Missing local provider address");
const environment = {
  ...process.env,
  OTEL_SDK_DISABLED: "true",
  OTEL_TRACES_EXPORTER: "none",
  OTEL_LOGS_EXPORTER: "none",
  OTEL_METRICS_EXPORTER: "none",
  LANGFUSE_PUBLIC_KEY: "",
  LANGFUSE_SECRET_KEY: "",
  SENTRY_DSN: "",
};
try {
  for (const name of ["enabled", "disabled", "blocked"]) {
    scenario = name;
    const home = join(root, name);
    await mkdir(join(home, ".yukino"), { recursive: true });
    await writeFile(join(home, "input.txt"), "actual CLI input\n");
    await writeFile(
      join(home, ".yukino", "config.yaml"),
      JSON.stringify({
        providers: [
          {
            name: "local",
            protocol: "openai-compat",
            model: "local",
            api_key: "local-test",
            base_url: `http://127.0.0.1:${address.port}/v1`,
            thinking: "off",
          },
        ],
        ...(name === "disabled"
          ? {}
          : { code_mode: { mode: "on", inline_budget: 12000 } }),
        enable_memory: false,
      }),
    );
    const child = spawn(
      process.execPath,
      [
        entry,
        "-p",
        "Exercise Code Mode",
        "--permission-mode",
        "bypassPermissions",
      ],
      {
        cwd: home,
        env: { ...environment, HOME: home },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "";
    let errors = "";
    child.stdout.on("data", (chunk) => {
      output += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      errors += String(chunk);
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
    const [code] = await once(child, "exit");
    clearTimeout(timer);
    assert.equal(code, 0, errors);
    const marker =
      name === "enabled"
        ? "CLI_CODE_MODE_OK"
        : name === "disabled"
          ? "CLI_CODE_MODE_DISABLED"
          : "CLI_CODE_MODE_BLOCKED";
    assert.ok(output.includes(marker), output + errors);
    if (name === "enabled")
      assert.ok(
        (await readFile(join(home, "output.txt"), "utf8")).includes(
          "actual CLI input",
        ),
      );
    console.log(output.trim());
  }
  assert.equal(requests, 5);
  const sdk = await import("@yukino.js/yukino");
  const cwd = join(root, "enabled");
  const registry = sdk.createToolRegistry(new sdk.TaskList(), {
    codeMode: { mode: "on", inline_budget: 12000 },
  });
  const conversation = new sdk.ConversationManager();
  conversation.addUserMessage("SDK smoke");
  let turn = 0;
  const agent = new sdk.Agent({
    client: {
      setSystemPrompt() {},
      async *stream() {
        await Promise.resolve();
        if (turn++ === 0)
          yield {
            type: "tool_call_complete",
            toolId: "sdk-code",
            toolName: "CodeMode",
            arguments: {
              code: 'return (await tools.ReadFile({file_path:"input.txt"})).output;',
            },
          };
        yield {
          type: "stream_end",
          stopReason: "end_turn",
          usage: {
            inputTokens: 0,
            outputTokens: 0,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
          },
        };
      },
    },
    registry,
    checker: new sdk.PermissionChecker(cwd, "bypassPermissions"),
    conversation,
    cwd,
  });
  try {
    let seen = false;
    for await (const event of agent.run()) {
      if (event.type === "tool_result") {
        assert.equal(event.isError, false, event.output);
        assert.ok(event.output.includes("actual CLI input"));
        seen = true;
      }
    }
    assert.ok(seen);
    console.log("SDK_CODE_MODE_OK");
  } finally {
    await registry.dispose();
  }
  process.env.HOME = cwd;
  sdk.saveMessage(cwd, "tui-recovery", {
    role: "user",
    timestamp: 1,
    content: "Resume this script",
  });
  sdk.saveMessage(cwd, "tui-recovery", {
    role: "assistant",
    timestamp: 2,
    content: "",
    tool_uses: [
      {
        tool_use_id: "tui-script",
        tool_name: "CodeMode",
        arguments: { code: 'return "TUI_RESUMED_OK";' },
      },
    ],
  });
  const session = `qoder-code-mode-${process.pid}`;
  const tmux = (args) => {
    const result = spawnSync("tmux", args, { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  tmux([
    "new-session",
    "-d",
    "-s",
    session,
    "-c",
    cwd,
    "-x",
    "120",
    "-y",
    "40",
    "env",
    `HOME=${cwd}`,
    "OTEL_SDK_DISABLED=true",
    "LANGFUSE_PUBLIC_KEY=",
    "LANGFUSE_SECRET_KEY=",
    "SENTRY_DSN=",
    process.execPath,
    entry,
    "--resume",
    "tui-recovery",
    "--permission-mode",
    "bypassPermissions",
  ]);
  try {
    const until = async (check) => {
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        if (check()) return;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error(tmux(["capture-pane", "-p", "-t", session]));
    };
    await until(() =>
      tmux(["capture-pane", "-p", "-t", session]).includes(
        "Resumed session tui-recovery",
      ),
    );
    assert.equal(
      sdk
        .rebuildFromSession(sdk.loadSession(cwd, "tui-recovery"))
        .some((message) =>
          message.toolResults?.some(
            (result) =>
              result.content.includes("TUI_RESUMED_OK") && !result.isError,
          ),
        ),
      false,
    );
    tmux(["send-keys", "-t", session, "/resume  tui-recovery"]);
    await until(() =>
      tmux(["capture-pane", "-p", "-t", session]).includes(
        "/resume  tui-recovery",
      ),
    );
    tmux(["send-keys", "-t", session, "Enter"]);
    await until(() => sdk.loadInputTexts().includes("/resume  tui-recovery"));
    const saved = sdk.loadSession(cwd, "tui-recovery");
    assert.equal(
      saved.filter((record) => record.type === "code-mode-recovery").length,
      0,
    );
    console.log(tmux(["capture-pane", "-p", "-t", session]).trim());
    console.log("TUI_CODE_MODE_DATA_ONLY_RESUME_OK");
    assert.equal(requests, 5);
  } finally {
    tmux(["kill-session", "-t", session]);
  }
} finally {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  server.close();
  await rm(root, { recursive: true, force: true });
}

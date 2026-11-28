import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = await mkdtemp(join(tmpdir(), "yukino-ui-runtime-cli-"));
const home = join(root, "home");
const homeCwd = process.argv.includes("--home-cwd");
const cwd = homeCwd ? home : join(root, "workspace");
const entry = fileURLToPath(new URL("../../src/cli.ts", import.meta.url));
const session = `yukino-ui-runtime-${process.pid}`;
let requests = 0;
const provider = createServer((request, response) => {
  request.resume();
  request.on("end", () => {
    requests++;
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(
      `data: ${JSON.stringify({ id: "local", object: "chat.completion.chunk", created: 1, model: "local", choices: [{ index: 0, delta: { role: "assistant", content: "UI_RUNTIME_OK" }, finish_reason: null }] })}\n\n`,
    );
    response.end(
      `data: ${JSON.stringify({ id: "local", object: "chat.completion.chunk", created: 1, model: "local", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } })}\n\ndata: [DONE]\n\n`,
    );
  });
});
provider.listen(0, "127.0.0.1");
await once(provider, "listening");
const address = provider.address();
assert.ok(address && typeof address !== "string");
const tmux = (...args) => {
  const result = spawnSync("tmux", args, { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
};
const capture = () => tmux("capture-pane", "-p", "-t", session);
const until = async (text) => {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const screen = capture();
    if (typeof text === "function" ? text(screen) : screen.includes(text))
      return screen;
    if (screen.includes(".omit() cannot") || screen.includes("Error:"))
      throw new Error(screen);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(capture());
};
try {
  await mkdir(cwd);
  await mkdir(join(home, ".yukino"), { recursive: true });
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
      enable_memory: false,
      permission_mode: process.argv.includes("--plan") ? "plan" : "default",
    }),
  );
  if (homeCwd) {
    await writeFile(
      join(home, ".mcp.json"),
      JSON.stringify({
        mcpServers: { offline: { command: "nonexistent-local-mcp-fixture" } },
      }),
    );
  }
  tmux("new-session", "-d", "-s", session, "-c", cwd, "-x", "120", "-y", "40");
  tmux("set-option", "-w", "-t", session, "remain-on-exit", "on");
  const launch = [
    "env",
    `HOME=${home}`,
    `TSX_TSCONFIG_PATH=${fileURLToPath(new URL("../../tsconfig.json", import.meta.url))}`,
    "OTEL_SDK_DISABLED=true",
    "LANGFUSE_PUBLIC_KEY=",
    "LANGFUSE_SECRET_KEY=",
    "SENTRY_DSN=",
    process.execPath,
    "--import",
    import.meta.resolve("tsx"),
    entry,
    "--cwd",
    cwd,
    homeCwd ? "--trust-project" : "--no-project-resources",
  ]
    .map((arg) => `'${arg.replaceAll("'", "'\\''")}'`)
    .join(" ");
  tmux("send-keys", "-t", session, launch, "Enter");
  await until("local");
  const submit = async (text) => {
    tmux("send-keys", "-t", session, text);
    await until(text.trimEnd());
    tmux("send-keys", "-t", session, "Enter");
  };
  await submit("ACTUAL_UI_PROMPT");
  await until("UI_RUNTIME_OK");
  await submit("/name Runtime smoke");
  await until("Session named Runtime smoke");
  await submit("/tree ");
  await until("Enter navigate");
  tmux("send-keys", "-t", session, "role:user");
  await until("Search: role:user");
  console.log(capture().trim());
  tmux("send-keys", "-t", session, "Enter");
  await until(
    (screen) =>
      !screen.includes("Session tree") && screen.includes("ACTUAL_UI_PROMPT"),
  );
  assert.equal(requests, 1, "Tree navigation must not run recorded work");
  console.log("ACTUAL_TUI_RUNTIME_TREE_OK");
  let remaining = "ACTUAL_UI_PROMPT".length;
  while (remaining > 0) {
    tmux("send-keys", "-t", session, "BSpace");
    remaining -= 1;
  }
  await submit("/quit ");
  await until(
    () =>
      tmux(
        "display-message",
        "-p",
        "-t",
        session,
        "#{pane_current_command}",
      ).trim() !== "node",
  );
} finally {
  spawnSync("tmux", ["kill-session", "-t", session]);
  provider.close();
  await rm(root, { recursive: true, force: true });
}

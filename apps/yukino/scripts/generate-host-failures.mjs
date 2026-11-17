import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const reference = resolve(
  process.argv[2] ?? join(homedir(), "github/yukino-code/packages/yukino"),
);
const { RemoteServer } = await import(
  pathToFileURL(join(reference, "src/remote/server.ts"))
);
const { ConversationManager } = await import(
  pathToFileURL(join(reference, "src/conversation/index.ts"))
);
const { createDefaultRegistry } = await import(
  pathToFileURL(join(reference, "src/commands/commands.ts"))
);
const originalCwd = process.cwd();
const directory = mkdtempSync(join(tmpdir(), "yukino-host-failures-"));
const scenarios = [];
try {
  process.chdir(directory);
  for (const name of [
    "provider-unknown",
    "provider-failed",
    "provider-save-failed",
    "model-failed",
    "model-unchanged",
    "image-empty",
    "image-invalid",
    "resume-missing",
    "resume-invalid-index",
    "compact-failed",
  ]) {
    const messages = [];
    const provider = {
      name: "p",
      protocol: "openai",
      base_url: "https://example.invalid",
      api_key: "test",
      model: "m",
    };
    const s = new RemoteServer({
      providers: [provider, { ...provider, name: "bad", protocol: "invalid" }],
      addr: "0",
      enableCoordinatorMode: false,
    });
    const handle = {
      client: {
        protocol: "openai",
        stream: async function* () {
          throw new Error("fixture compact failure");
        },
      },
      provider,
      cwd: directory,
      sessionId: "fixture-session",
      conv: new ConversationManager(),
      registry: { listVisibleToolNames: () => [], getAllSchemas: () => [] },
      cmdRegistry: createDefaultRegistry(),
      stopMemoryTasks: async () => {},
    };
    s.agentHandle = handle;
    s.broadcast = (message) => messages.push(structuredClone(message));
    switch (name) {
      case "provider-unknown":
        await s.applyProviderSwitch(99);
        break;
      case "provider-failed":
        await s.applyProviderSwitch(1);
        break;
      case "provider-save-failed":
        await s.handleProviderSave({ ...provider, name: "" });
        break;
      case "model-failed":
        provider.protocol = "invalid";
        await s.applyModel("next");
        break;
      case "model-unchanged":
        await s.applyModel("m");
        break;
      case "image-empty":
        await s.handleImageUpload(
          { clientId: "image", name: "empty.png", dataBase64: "" },
          (message) => messages.push(message),
        );
        break;
      case "image-invalid":
        await s.handleImageUpload(
          {
            clientId: "image",
            name: "invalid.png",
            dataBase64: "bm90IGFuIGltYWdl",
          },
          (message) => messages.push(message),
        );
        break;
      case "resume-missing":
        await s.handleResume("missing");
        break;
      case "resume-invalid-index":
        await s.handleResume("1x");
        break;
      case "compact-failed":
        for (let i = 0; i < 30; i++)
          handle.conv.appendMessages([
            { role: i % 2 ? "assistant" : "user", content: `message ${i}` },
          ]);
        await s.handleCompact("fixture instructions");
        break;
    }
    for (const message of messages) {
      if (!message.data?.message) continue;
      message.data.message = message.data.message.replace(
        /^(Failed to (?:switch provider|switch model|save provider)): [\s\S]*$/u,
        "$1: <runtime-error>",
      );
    }
    scenarios.push({ name, messages });
  }
} finally {
  process.chdir(originalCwd);
  rmSync(directory, { recursive: true, force: true });
}
const sourceHash = createHash("sha256")
  .update(readFileSync(join(reference, "src/remote/server.ts")))
  .digest("hex");
const output = join(
  dirname(fileURLToPath(import.meta.url)),
  "../internal/remote/testdata/host-failures.json",
);
writeFileSync(
  output,
  JSON.stringify({ source_sha256: sourceHash, scenarios }, null, 2) + "\n",
);
console.log(JSON.stringify({ output, scenarios: scenarios.length }));

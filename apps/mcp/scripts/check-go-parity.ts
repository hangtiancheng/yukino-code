// Run from apps/mcp: GO=/path/to/go node_modules/.bin/tsx --tsconfig tsconfig.json scripts/check-go-parity.ts
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { createServer as createHTTPServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createServer } from "../src/server.js";
import { docsModule } from "../src/tools/docs/tool.js";
import { goInputSchema } from "./go-contract.js";

const directory = await mkdtemp(join(tmpdir(), "yukino-mcp-parity-"));
const executable = join(directory, "yukino-mcp");
execFileSync(
  process.env["GO"] ?? "go",
  ["build", "-o", executable, "./cmd/yukino-mcp"],
  {
    cwd: fileURLToPath(new URL("../../dejavu/", import.meta.url)),
    stdio: "inherit",
  },
);
let failEmbeddings = false;
const http = createHTTPServer(async (request, response) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString();
  const url = new URL(request.url!, "http://fixture");
  response.setHeader("content-type", "application/json");
  response.setHeader("date", "Tue, 13 Oct 2026 00:00:00 GMT");
  if (url.pathname === "/embeddings") {
    if (failEmbeddings) {
      response.writeHead(400);
      response.end('{"error":{"message":"fixture rejection"}}');
      return;
    }
    const input = JSON.parse(text).input;
    const inputs = Array.isArray(input) ? input : [input];
    response.end(
      JSON.stringify({
        object: "list",
        model: "test",
        data: inputs.map((_: unknown, index: number) => ({
          object: "embedding",
          index,
          embedding: [0.1, 0.2, 0.3],
        })),
        usage: { prompt_tokens: 1, total_tokens: 1 },
      }),
    );
    return;
  }
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {}
  response.end(
    JSON.stringify({
      path: url.pathname,
      method: request.method,
      query: Object.fromEntries(url.searchParams),
      body,
      authorization: request.headers.authorization ?? null,
    }),
  );
});
await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
const address = http.address();
assert(address && typeof address !== "string");
const base = `http://127.0.0.1:${address.port}`;
const docs = join(directory, "docs");
await mkdir(docs);
await writeFile(join(docs, "中文.md"), "中".repeat(1000));
const settings: Record<string, string> = {
  MCP_TRANSPORT: "stdio",
  DOTENV_CONFIG_PATH: join(directory, "absent.env"),
  YUKINO_DOCS_DIR: docs,
  YUKINO_INDEX_DB: join(directory, "ts.sqlite"),
  EMBEDDING_BASE_URL: base,
  EMBEDDING_MODEL: "test",
  EMBEDDING_API_KEY: "test",
  MINIO_ACCESS_KEY: "fixture",
  MINIO_SECRET_KEY: "fixture",
  LOG_LEVEL: "error",
};
const goConfig = join(directory, "go.json");
await writeFile(
  goConfig,
  JSON.stringify({
    transport: "stdio",
    docs_dir: docs,
    index: { db_path: join(directory, "go.sqlite") },
    embedding: { base_url: base, model: "test", api_key: "test" },
    minio: { access_key: "fixture", secret_key: "fixture" },
  }),
  { mode: 0o600 },
);
Object.assign(process.env, settings);
const tsServer = createServer();
const tsClient = new Client({ name: "ts-parity", version: "1" });
const goClient = new Client({ name: "go-parity", version: "1" });
const [a, b] = InMemoryTransport.createLinkedPair();
let checks = 0;
try {
  await Promise.all([
    tsClient.connect(a),
    tsServer.connect(b),
    goClient.connect(
      new StdioClientTransport({
        command: executable,
        args: ["--config", goConfig],
        env: {
          ...Object.fromEntries(
            Object.entries(process.env).filter(
              (pair): pair is [string, string] => pair[1] !== undefined,
            ),
          ),
          ...settings,
          YUKINO_INDEX_DB: join(directory, "go.sqlite"),
        },
        stderr: "pipe",
      }),
    ),
  ]);
  const contracts = (
    tools: Awaited<ReturnType<Client["listTools"]>>["tools"],
  ) =>
    tools
      .map(({ name, inputSchema, annotations, _meta }) => ({
        name,
        inputSchema: goInputSchema({ name, inputSchema }),
        annotations,
        _meta,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  const [tsTools, goTools] = await Promise.all([
    tsClient.listTools(),
    goClient.listTools(),
  ]);
  assert.equal(tsTools.tools.length, 15);
  assert.deepEqual(contracts(goTools.tools), contracts(tsTools.tools));
  checks++;
  async function compare(
    name: string,
    args: Record<string, unknown>,
    valid = true,
  ) {
    const [ts, go] = await Promise.all([
      tsClient.callTool({ name, arguments: args }),
      goClient.callTool({ name, arguments: args }),
    ]);
    assert.equal(!!ts.isError, !valid, `${name}: TS error status`);
    assert.equal(!!go.isError, !valid, `${name}: Go error status`);
    if (valid)
      assert.deepEqual(
        go.structuredContent,
        ts.structuredContent,
        `${name}: successful result`,
      );
    checks++;
  }
  await compare("create_app", {
    html: "<p>中文😀</p>",
    title: "中".repeat(60),
  });
  await compare("create_app", { html: "<p/>" });
  await compare("create_app", { html: "<p/>", title: "😀".repeat(61) });
  await compare("create_app", { html: "<p/>", title: "😀".repeat(121) }, false);
  for (const [name, args] of [
    ["kafka_tool", { operation: "invalid" }],
    ["mysql_tool", { sql: "SELECT 1", connection_url: " \ufeff " }],
    ["docs_tool", { query: "query", top_k: 11 }],
    ["grafana_tool", { method: "CONNECT" }],
  ] as const)
    await compare(name, args, false);
  for (const name of ["prometheus_tool", "grafana_tool"]) {
    for (const body of [undefined, null, "raw string", { nested: [true, 1] }]) {
      await compare(name, {
        base_url: base,
        path: "/echo",
        method: "POST",
        params: { query: "中文", number: 1e21 },
        ...(body === undefined ? {} : { body }),
      });
    }
    await compare(
      name,
      { base_url: base, path: "/echo", method: "GET", body: null },
      false,
    );
  }
  await compare("clickhouse_tool", {
    connection_url: base,
    sql: "INSERT INTO test FORMAT CSV",
    data_base64: "YWJj !",
    format: "JSON",
  });
  await compare("etcd_tool", {
    base_url: base,
    path: "/v3/kv/put",
    body: { key: "中文", value: "value" },
  });
  await compare("milvus_tool", {
    base_url: base,
    path: "/v2/vectordb/entities/query",
    database: "test",
    body: { filter: "id > 0" },
  });
  // Initial sync can finish before docs_sync is called. Compare stable state,
  // then a subsequent explicit refresh after both servers have settled.
  await Promise.all([
    tsClient.callTool({ name: "docs_sync", arguments: {} }),
    goClient.callTool({ name: "docs_sync", arguments: {} }),
  ]);
  await compare("docs_tool", { query: "中文", top_k: 10 });
  await writeFile(join(docs, "emoji.md"), "a" + "😀".repeat(600));
  await compare("docs_sync", {});
  await compare("docs_tool", { query: "emoji", top_k: 10 });
  failEmbeddings = true;
  await writeFile(join(docs, "中文.md"), "changed");
  await compare("docs_sync", {}, false);
  failEmbeddings = false;
  await compare("docs_sync", {});
  await compare("docs_tool", { query: "changed", top_k: 10 });
  await rm(join(docs, "emoji.md"));
  await compare("docs_sync", {});
  await compare("docs_tool", { query: "remaining", top_k: 10 });
  console.log(
    `TS/Go parity: ${checks} checks passed (15 tool contracts, validation, app, HTTP, SQL gateway and RAG).`,
  );
} finally {
  await Promise.allSettled([
    tsClient.close(),
    goClient.close(),
    tsServer.close(),
    docsModule.shutdown?.(),
  ]);
  await new Promise<void>((resolve, reject) =>
    http.close((err) => (err ? reject(err) : resolve())),
  );
  await rm(directory, { recursive: true, force: true });
}

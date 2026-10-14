// Run from apps/mcp: node_modules/.bin/tsx --tsconfig tsconfig.json scripts/export-go-contract.ts
// Keep the Go tool schemas tied to the public TypeScript MCP contract.
import { writeFile } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";
import { goInputSchema } from "./go-contract.js";

const server = createServer();
const client = new Client({ name: "export-go-contract", version: "1" });
const [a, b] = InMemoryTransport.createLinkedPair();
try {
  await Promise.all([client.connect(a), server.connect(b)]);
  const { tools } = await client.listTools();
  const contracts = Object.fromEntries(
    tools
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((tool) => [
        tool.name,
        {
          inputSchema: goInputSchema(tool),
          annotations: tool.annotations,
          ...(tool._meta ? { _meta: tool._meta } : {}),
        },
      ]),
  );
  await writeFile(
    new URL("../../dejavu/internal/tools/contracts.json", import.meta.url),
    JSON.stringify(contracts, null, 2) + "\n",
  );
} finally {
  await Promise.all([client.close(), server.close()]);
}

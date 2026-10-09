import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MCPClient } from "@/mcp/client.js";

afterEach(() => vi.restoreAllMocks());
function connected() {
  const sdk = new Client({ name: "test", version: "1" });
  const client = new MCPClient({ name: "server" });
  Reflect.set(client, "client", sdk);
  return { client, sdk };
}
const tool = (name: string) => ({
  name,
  inputSchema: { type: "object" as const },
});

describe("MCP tool pagination", () => {
  it("collects all pages in order and fills optional schema properties", async () => {
    const { client, sdk } = connected();
    const list = vi
      .spyOn(sdk, "listTools")
      .mockResolvedValueOnce({ tools: [tool("first")], nextCursor: "page2" })
      .mockResolvedValueOnce({ tools: [tool("second")], nextCursor: "page3" })
      .mockResolvedValueOnce({ tools: [tool("third")] });
    expect((await client.listTools()).map((item) => item.name)).toEqual([
      "first",
      "second",
      "third",
    ]);
    expect(list.mock.calls.map(([params]) => params)).toEqual([
      undefined,
      { cursor: "page2" },
      { cursor: "page3" },
    ]);
  });

  it("rejects a repeated cursor instead of looping forever", async () => {
    const { client, sdk } = connected();
    const list = vi
      .spyOn(sdk, "listTools")
      .mockResolvedValue({ tools: [], nextCursor: "repeat" });
    await expect(client.listTools()).rejects.toThrow("repeated tools cursor");
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("treats an empty-string cursor as an opaque pagination token", async () => {
    const { client, sdk } = connected();
    const list = vi
      .spyOn(sdk, "listTools")
      .mockResolvedValueOnce({ tools: [], nextCursor: "" })
      .mockResolvedValueOnce({ tools: [tool("last")] });
    expect(await client.listTools()).toHaveLength(1);
    expect(list).toHaveBeenLastCalledWith({ cursor: "" });
  });

  it("propagates a later page failure without returning a partial list", async () => {
    const { client, sdk } = connected();
    vi.spyOn(sdk, "listTools")
      .mockResolvedValueOnce({ tools: [tool("first")], nextCursor: "page2" })
      .mockRejectedValueOnce(new Error("page failed"));
    await expect(client.listTools()).rejects.toThrow("page failed");
  });
});

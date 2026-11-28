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
  it("bounds pages/items and cancels a hanging SDK request", async () => {
    const { client, sdk } = connected();
    const list = vi
      .spyOn(sdk, "listTools")
      .mockResolvedValue({ tools: [tool("one")], nextCursor: "more" });
    await expect(client.listTools({ maxPages: 1 })).rejects.toThrow(
      "page limit",
    );
    list.mockResolvedValue({ tools: [tool("one"), tool("two")] });
    await expect(client.listTools({ maxItems: 1 })).rejects.toThrow(
      "item limit",
    );
    list.mockImplementation(() => new Promise(() => undefined));
    const controller = new AbortController();
    const listing = client.listTools({ signal: controller.signal });
    controller.abort();
    await expect(listing).rejects.toThrow();
    await expect(client.listTools({ timeoutMs: 10 })).rejects.toThrow();
  });
  it("lists resources and templates with cursors while keeping Apps dedicated", async () => {
    const { client, sdk } = connected();
    const resources = vi
      .spyOn(sdk, "listResources")
      .mockResolvedValueOnce({
        resources: [
          { name: "first", uri: "docs://first" },
          { name: "app", uri: "ui://app" },
        ],
        nextCursor: "next",
      })
      .mockResolvedValueOnce({
        resources: [{ name: "second", uri: "docs://second" }],
      });
    expect(
      (await client.listResources()).map((resource) => resource.uri),
    ).toEqual(["docs://first", "docs://second"]);
    expect(resources.mock.calls[1][0]).toEqual({ cursor: "next" });
    vi.spyOn(sdk, "listResourceTemplates").mockResolvedValue({
      resourceTemplates: [{ name: "template", uriTemplate: "docs://{path}" }],
    });
    expect((await client.listResourceTemplates())[0].uriTemplate).toBe(
      "docs://{path}",
    );
  });
  it.each(["listResources", "listResourcesPage"] as const)(
    "%s rejects results when resource access changes during the request",
    async (method) => {
      const { client, sdk } = connected();
      const listing = vi.spyOn(sdk, "listResources").mockImplementation(() => {
        client.updateConfig({ name: "server", exposure: "hidden" });
        return Promise.resolve({
          resources: [{ name: "old", uri: "docs://old" }],
          nextCursor: "more",
        });
      });
      await expect(client[method]()).rejects.toThrow("unavailable");
      expect(listing).toHaveBeenCalledOnce();
    },
  );
  it("continues bounded resource pages without dropping buffered resources or backend cursors", async () => {
    const { client, sdk } = connected();
    const resources = vi
      .spyOn(sdk, "listResources")
      .mockResolvedValueOnce({
        resources: [
          { name: "one", uri: "docs://one" },
          { name: "two", uri: "docs://two" },
        ],
        nextCursor: "",
      })
      .mockResolvedValueOnce({
        resources: [{ name: "three", uri: "docs://three" }],
      });
    const one = await client.listResourcesPage({ limit: 1 });
    expect(one.items.map((item) => item.name)).toEqual(["one"]);
    const two = await client.listResourcesPage({
      cursor: one.nextCursor,
      limit: 1,
    });
    expect(two.items.map((item) => item.name)).toEqual(["two"]);
    expect(resources).toHaveBeenCalledTimes(1);
    const three = await client.listResourcesPage({
      cursor: two.nextCursor,
      limit: 1,
    });
    expect(three.items.map((item) => item.name)).toEqual(["three"]);
    expect(three.nextCursor).toBeUndefined();
    expect(resources.mock.calls.at(-1)?.[0]).toEqual({ cursor: "" });
    await expect(client.listResourcesPage({ limit: 0 })).rejects.toThrow(
      "pagination",
    );
  });
  it("rejects cross-list and expired cursors, hidden/codemode access, and cancelled pages", async () => {
    const { client, sdk } = connected();
    const list = vi.spyOn(sdk, "listResources").mockResolvedValue({
      resources: [
        { name: "one", uri: "docs://one" },
        { name: "two", uri: "docs://two" },
      ],
    });
    const page = await client.listResourcesPage({ limit: 1 });
    await expect(
      client.listResourceTemplatesPage({ cursor: page.nextCursor }),
    ).rejects.toThrow("another list");
    for (const exposure of ["hidden", "codemode"] as const) {
      client.updateConfig({ name: "server", exposure });
      await expect(client.listResourcesPage()).rejects.toThrow("unavailable");
    }
    client.updateConfig({ name: "server", exposure: "direct" });
    const controller = new AbortController();
    controller.abort();
    await expect(
      client.listResourcesPage({ signal: controller.signal }),
    ).rejects.toThrow();
    expect(list).toHaveBeenCalledOnce();
    await client.disconnect();
  });
  it("preserves structured content and the complete SDK raw result", async () => {
    const { client, sdk } = connected();
    const result = {
      content: [{ type: "text" as const, text: "fallback" }],
      structuredContent: { nested: { data: [1, 2] } },
      isError: true,
      _meta: { provenance: "mock" },
    };
    const call = vi.spyOn(sdk, "callTool").mockResolvedValue(result);
    const converted = await client.callTool("mock", {});
    expect(converted.structuredContent).toEqual(result.structuredContent);
    expect(converted.mcpResult).toEqual(result);
    expect(converted.rawContent).toEqual(result.content);
    expect(converted.isError).toBe(true);
    expect(call).toHaveBeenCalledTimes(1);
  });
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
    expect(list.mock.calls.at(-1)?.[0]).toEqual({ cursor: "" });
    expect(list.mock.calls.at(-1)?.[1]?.signal).toBeInstanceOf(AbortSignal);
    expect(list.mock.calls.at(-1)?.[1]?.timeout).toBe(30_000);
  });

  it("propagates a later page failure without returning a partial list", async () => {
    const { client, sdk } = connected();
    vi.spyOn(sdk, "listTools")
      .mockResolvedValueOnce({ tools: [tool("first")], nextCursor: "page2" })
      .mockRejectedValueOnce(new Error("page failed"));
    await expect(client.listTools()).rejects.toThrow("page failed");
  });
});

import { once } from "node:events";
import { createServer, type Server, type RequestListener } from "node:http";
import type { LookupFunction } from "node:net";

import type * as Undici from "undici";
import { afterEach, expect, it, vi } from "vitest";

import { fetchPublicHttpUrl } from "@/utils/public-http.js";

const captured = vi.hoisted(() => {
  const state: { lookup?: LookupFunction } = {};
  return state;
});
vi.mock("undici", async (importOriginal) => {
  const actual = await importOriginal<typeof Undici>();
  return {
    ...actual,
    Agent: class extends actual.Agent {
      constructor(options: ConstructorParameters<typeof actual.Agent>[0]) {
        if (
          typeof options?.connect === "object" &&
          "lookup" in options.connect
        ) {
          captured.lookup = options.connect.lookup;
        }
        super({
          connect: {
            lookup: (_hostname, options, callback) => {
              if (options.all) {
                callback(null, [{ address: "127.0.0.1", family: 4 }]);
              } else {
                callback(null, "127.0.0.1", 4);
              }
            },
          },
        });
      }
    },
  };
});

const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) =>
      server.close(() => {
        resolve();
      }),
    );
  }
  captured.lookup = undefined;
});
async function endpoint(handler: RequestListener) {
  const server = createServer(handler);
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Missing listener");
  }
  return `http://public.example:${String(address.port)}/skill`;
}
const lookup = () => Promise.resolve([{ address: "93.184.216.34", family: 4 }]);

it("uses the validated DNS address in the transport and streams the response", async () => {
  const url = await endpoint((_request, response) => {
    response.end("downloaded text");
  });
  const response = await fetchPublicHttpUrl(url, {}, { lookup });
  expect(await response.text()).toBe("downloaded text");
  expect(captured.lookup).toBeTypeOf("function");
  const resolved = await new Promise<string>((resolve, reject) => {
    captured.lookup?.("public.example", {}, (error, address) => {
      if (error) {
        reject(error);
      } else if (typeof address === "string") {
        resolve(address);
      } else {
        reject(new Error("Expected one pinned address"));
      }
    });
  });
  expect(resolved).toBe("93.184.216.34");
});

it("propagates interrupted downloads to the response reader", async () => {
  const url = await endpoint((_request, response) => {
    response.write("partial");
    setTimeout(() => response.destroy(new Error("download interrupted")), 20);
  });
  const response = await fetchPublicHttpUrl(url, {}, { lookup });
  await expect(response.text()).rejects.toThrow();
});

it("returns no response body for HEAD", async () => {
  const url = await endpoint((_request, response) => response.end());
  const response = await fetchPublicHttpUrl(
    url,
    { method: "HEAD" },
    { lookup },
  );
  expect(response.body).toBeNull();
});

it("revalidates redirected hosts and rejects private addresses before connecting", async () => {
  const url = await endpoint((_request, response) => {
    response.writeHead(302, { location: "http://127.0.0.1/private" });
    response.end();
  });
  await expect(fetchPublicHttpUrl(url, {}, { lookup })).rejects.toThrow(
    "non-public",
  );
});

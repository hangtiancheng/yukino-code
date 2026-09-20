/**
 * Copyright (c) 2026 hangtiancheng
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

import { z } from "zod";

import type { ProviderConfig } from "@/config/index.js";

const DISCOVERY_TIMEOUT_MS = 5_000;
const MAX_MODEL_PAGES = 10;
const HttpUrlSchema = z.url();
const ModelSchema = z.object({
  id: z.string().trim().min(1),
  display_name: z.string().optional(),
  name: z.string().optional(),
});
const ModelListSchema = z.object({
  data: z.array(ModelSchema),
  has_more: z.boolean().optional(),
  last_id: z.string().trim().min(1).nullable().optional(),
});

type DiscoveryConfig = Pick<
  ProviderConfig,
  "protocol" | "base_url" | "api_key"
>;
export type DiscoveredModel = z.infer<typeof ModelSchema>;

export function modelListUrl(
  protocol: ProviderConfig["protocol"],
  baseUrl: string,
): string | undefined {
  const parsed = HttpUrlSchema.safeParse(baseUrl);
  if (!parsed.success) {
    return undefined;
  }
  const url = new URL(parsed.data);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  ) {
    return undefined;
  }

  let path = url.pathname.replace(/\/+$/, "");
  path = path.replace(
    /\/(?:chat\/completions|completions|responses|messages|models)$/,
    "",
  );
  if (!path || (protocol === "anthropic" && !path.endsWith("/v1"))) {
    path += "/v1";
  }
  url.pathname = `${path}/models`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

export async function discoverModels(
  config: DiscoveryConfig,
  signal?: AbortSignal,
): Promise<DiscoveredModel[]> {
  const endpoint = modelListUrl(config.protocol, config.base_url);
  if (!endpoint) {
    throw new Error(
      "Model discovery requires an HTTP(S) URL without embedded credentials",
    );
  }

  const controller = new AbortController();
  const abort = () => {
    controller.abort();
  };
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) {
    abort();
  }
  const timeout = setTimeout(abort, DISCOVERY_TIMEOUT_MS);
  const apiKey = config.api_key?.trim();
  const headers: Record<string, string> = { Accept: "application/json" };
  if (config.protocol === "anthropic") {
    headers["anthropic-version"] = "2023-06-01";
    if (apiKey) {
      headers["x-api-key"] = apiKey;
    }
  } else if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  try {
    const models = new Map<string, DiscoveredModel>();
    const cursors = new Set<string>();
    const url = new URL(endpoint);
    for (let page = 0; page < MAX_MODEL_PAGES; page += 1) {
      controller.signal.throwIfAborted();
      const response = await fetch(url.toString(), {
        method: "GET",
        headers,
        signal: controller.signal,
        redirect: "error",
      });
      if (!response.ok) {
        throw new Error("Model discovery failed");
      }
      const body: unknown = await response.json();
      controller.signal.throwIfAborted();
      const list = ModelListSchema.parse(body);
      for (const model of list.data) {
        if (!models.has(model.id)) {
          models.set(model.id, model);
        }
      }
      if (config.protocol !== "anthropic" || !list.has_more) {
        return [...models.values()];
      }
      if (!list.last_id || cursors.has(list.last_id)) {
        throw new Error("Model discovery failed");
      }
      cursors.add(list.last_id);
      url.searchParams.set("after_id", list.last_id);
    }
    throw new Error("Model discovery failed");
  } catch {
    if (controller.signal.aborted) {
      throw new DOMException(
        "Model discovery cancelled or timed out",
        "AbortError",
      );
    }
    throw new Error("Model discovery failed");
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
  }
}

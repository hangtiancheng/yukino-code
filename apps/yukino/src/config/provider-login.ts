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

import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import yaml from "js-yaml";
import { z } from "zod";

import {
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_OUTPUT_TOKENS,
  getThinkingLevel,
  globalConfigPath,
  ProviderConfigSchema,
  type ProviderConfig,
  THINKING_LEVELS,
  type ThinkingLevel,
} from "./index.js";

const tokenLimit = (fallback: number, min: number, max: number) =>
  z.preprocess(
    (value) =>
      value === undefined || (typeof value === "string" && !value.trim())
        ? fallback
        : value,
    z
      .union([
        z.number(),
        z
          .string()
          .trim()
          .regex(/^\d+$/, "Enter a whole number")
          .transform(Number),
      ])
      .pipe(z.number().int().min(min).max(max)),
  );

export const ProviderLoginSchema = ProviderConfigSchema.extend({
  name: z.string().trim().min(1, "Name is required"),
  base_url: z
    .url("Enter a valid HTTP(S) URL")
    .refine((url) => /^https?:\/\//i.test(url), "Use an HTTP(S) URL"),
  api_key: z.string().trim().min(1, "API key is required"),
  model: z.string().trim().min(1, "Model is required"),
  thinking: z.enum(THINKING_LEVELS).optional(),
  context_window: tokenLimit(DEFAULT_CONTEXT_WINDOW, 1_000, 10_000_000),
  max_output_tokens: tokenLimit(DEFAULT_MAX_OUTPUT_TOKENS, 1, 1_000_000),
})
  .refine((provider) => provider.max_output_tokens <= provider.context_window, {
    path: ["max_output_tokens"],
    message: "Max output tokens must not exceed the context window",
  })
  // Persist an explicit effective level, retaining all capability metadata.
  .transform((provider) => ({
    ...provider,
    thinking: getThinkingLevel(provider),
  }));

/** Read the raw global config as a record; an absent file yields {}. */
function readConfigRaw(path: string): Record<string, unknown> {
  if (!existsSync(path)) {
    return {};
  }
  let raw: unknown;
  try {
    raw = yaml.load(readFileSync(path, "utf-8"));
  } catch {
    throw new Error(
      `Unable to read existing ${path}; it has not been changed.`,
    );
  }
  return z.record(z.string(), z.unknown()).parse(raw ?? {});
}

/** Atomically write the global config, preserving 0600 permissions. */
function writeConfigAtomic(path: string, raw: Record<string, unknown>): void {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true });
  const temporary = join(directory, `.config-${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, yaml.dump(raw, { lineWidth: -1, noRefs: true }), {
      encoding: "utf-8",
      mode: 0o600,
      flag: "wx",
    });
    renameSync(temporary, path);
  } finally {
    if (existsSync(temporary)) {
      unlinkSync(temporary);
    }
  }
}

/**
 * Save a provider to the single global config ($HOME/.yukino/config.yaml),
 * retaining every currently available provider. `base_url` is the provider
 * identity: an entry with the same base_url is replaced in place instead of
 * appended, and names may repeat freely.
 */
export function saveProvider(
  input: unknown,
  available: ProviderConfig[],
): {
  provider: ProviderConfig;
  providers: ProviderConfig[];
  /** Whether an existing entry with the same base_url was replaced. */
  replaced: boolean;
  path: string;
} {
  const provider = ProviderLoginSchema.parse(input);
  const path = globalConfigPath();
  const config = readConfigRaw(path);
  const existing = z
    .array(z.record(z.string(), z.unknown()))
    .parse(config.providers ?? []);
  // Retain every currently available provider so an in-memory list never loses
  // entries that are not yet written to the file.
  const current = [...existing];
  for (const entry of available) {
    if (!current.some((stored) => stored.base_url === entry.base_url)) {
      current.push({ ...entry });
    }
  }
  const stored: Record<string, unknown>[] = [];
  let replaced = false;
  for (const entry of current) {
    if (entry.base_url !== provider.base_url) {
      stored.push(entry);
      continue;
    }
    // Replace the first match in place and drop any further duplicates, so one
    // endpoint keeps exactly one entry even in configs written by the old
    // name-suffixing strategy.
    if (replaced) {
      continue;
    }
    replaced = true;
    stored.push(provider);
  }
  if (!replaced) {
    stored.push(provider);
  }
  const providers = stored.map((entry) => ProviderConfigSchema.parse(entry));
  writeConfigAtomic(path, { ...config, providers: stored });
  return { provider, providers, replaced, path };
}

/**
 * Persist a provider's thinking level to the global config. `base_url` is the
 * provider identity, so every entry for that endpoint is updated. Throws when
 * the endpoint is absent so callers can surface a clear error.
 */
export function persistThinkingLevel(
  baseUrl: string,
  level: ThinkingLevel,
): void {
  const path = globalConfigPath();
  const config = readConfigRaw(path);
  const providers = z
    .array(z.record(z.string(), z.unknown()))
    .parse(config.providers ?? []);
  const targets = providers.filter((entry) => entry.base_url === baseUrl);
  if (targets.length === 0) {
    throw new Error(
      `Provider with base URL "${baseUrl}" not found in ${path}.`,
    );
  }
  const changed = targets.filter((entry) => entry.thinking !== level);
  // Avoid rewriting (and reformatting) the file when nothing changes.
  if (changed.length === 0) {
    return;
  }
  for (const entry of changed) {
    entry.thinking = level;
  }
  writeConfigAtomic(path, { ...config, providers });
}

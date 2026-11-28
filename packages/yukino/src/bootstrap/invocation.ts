import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { Readable } from "node:stream";

import {
  INVOCATION_MAX_ATTACHMENTS,
  INVOCATION_MAX_INPUT_BYTES,
  INVOCATION_MAX_TEXT_BYTES,
} from "@/bootstrap/constants.js";
import type { InvocationOptions } from "@/cli.js";
import { applyConfigEnv, loadConfig } from "@/config/index.js";
import {
  globalConfigPath,
  resolveDefaultProvider,
  withProviderDefaults,
  type ProviderConfig,
} from "@/config/provider-config.js";
import { isImagePath, loadImageAttachment } from "@/images/index.js";
import { buildSystemPrompt, detectEnvironment } from "@/prompt/builder.js";
import { canonicalPath } from "@/utils/paths.js";

export async function readInvocationText(
  path: string,
  cwd: string,
): Promise<string> {
  const absolute = resolve(cwd, path);
  const info = await stat(absolute);
  if (!info.isFile() || info.size > INVOCATION_MAX_TEXT_BYTES) {
    throw new Error("Invocation text must be a file within the size limit");
  }
  const bytes = await readFile(absolute);
  if (bytes.byteLength > INVOCATION_MAX_TEXT_BYTES || bytes.includes(0)) {
    throw new Error("Invocation text must contain bounded UTF-8 text");
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

export function resolveInvocationProvider(
  providers: ProviderConfig[],
  defaultProvider: number,
  options: InvocationOptions,
): ProviderConfig {
  const selected = options.provider
    ? providers.find((provider) => provider.name === options.provider)
    : resolveDefaultProvider(providers, defaultProvider);
  if (!selected) {
    throw new Error("Requested provider is not configured");
  }
  let provider = selected;
  if (options.model && options.model !== selected.model) {
    provider = {
      name: selected.name,
      protocol: selected.protocol,
      base_url: selected.base_url,
      api_key: selected.api_key,
      model: options.model,
    };
  }
  return withProviderDefaults({
    ...provider,
    ...(options.thinking ? { thinking: options.thinking } : {}),
  });
}

export async function loadInvocation(options: InvocationOptions = {}) {
  const cwd = canonicalPath(resolve(options.cwd ?? process.cwd()));
  const configPath = options.config
    ? resolve(cwd, options.config)
    : globalConfigPath();
  const config = loadConfig(options.config ? configPath : undefined);
  applyConfigEnv(config.env);
  const provider = resolveInvocationProvider(
    config.providers,
    config.default_provider,
    options,
  );
  let systemPrompt = options.systemPrompt;
  if (options.systemPromptFile) {
    systemPrompt = await readInvocationText(options.systemPromptFile, cwd);
  }
  if (systemPrompt === undefined) {
    const environment = detectEnvironment(cwd, { skipGit: true });
    environment.model = provider.model;
    systemPrompt = buildSystemPrompt(environment);
  }
  if (options.appendSystemPromptFile) {
    systemPrompt +=
      "\n\n" + (await readInvocationText(options.appendSystemPromptFile, cwd));
  }
  return { cwd, config, configPath, provider, systemPrompt };
}

export async function readStdinPrompt(input: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const raw of input) {
    const chunk: unknown = raw;
    if (!Buffer.isBuffer(chunk) && typeof chunk !== "string") {
      throw new Error("Expected UTF-8 stdin prompt");
    }
    const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    bytes += buffer.byteLength;
    if (bytes > INVOCATION_MAX_TEXT_BYTES) {
      throw new Error("Stdin prompt size limit exceeded");
    }
    chunks.push(buffer);
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(
    Buffer.concat(chunks),
  );
}

export async function loadInvocationInput(
  prompt: string,
  options: InvocationOptions = {},
  cwd = process.cwd(),
): Promise<string | Record<string, unknown>[]> {
  let text = prompt;
  if (options.stdin) {
    text += (text ? "\n" : "") + (await readStdinPrompt(process.stdin));
  }
  const paths = options.attachments ?? [];
  if (paths.length > INVOCATION_MAX_ATTACHMENTS) {
    throw new Error("Invocation attachment limit exceeded");
  }
  const blocks: Record<string, unknown>[] = [{ type: "text", text }];
  let bytes = Buffer.byteLength(text);
  for (const path of paths) {
    const absolute = resolve(cwd, path);
    if (isImagePath(absolute)) {
      const image = await loadImageAttachment(absolute);
      bytes += image.byteLength;
      blocks.push({
        type: "image",
        source: {
          type: "base64",
          media_type: image.mediaType,
          data: image.data,
        },
      });
    } else {
      const content = await readInvocationText(absolute, cwd);
      bytes += Buffer.byteLength(content);
      blocks.push({
        type: "text",
        text: `<attachment path=${JSON.stringify(path)}>\n${content}\n</attachment>`,
      });
    }
    if (bytes > INVOCATION_MAX_INPUT_BYTES) {
      throw new Error("Invocation attachment byte limit exceeded");
    }
  }
  if (!text.trim() && paths.length === 0) {
    throw new Error("Prompt is empty");
  }
  return paths.length ? blocks : text;
}

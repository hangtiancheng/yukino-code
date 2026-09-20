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

import { createChildLogger } from "@/logger/index.js";

// Submodule namespaces for library consumers (Utils.<Sub>.*).
export * as Paths from "./paths.js";
export * as Verbs from "./verbs.js";

const log = createChildLogger({ module: "utils" });

/** Convert message or legacy-session blocks to a base64-free text fallback. */
export function contentToText(content: string | Record<string, unknown>[]): string {
  if (typeof content === "string") {
    return content;
  }
  const parts: string[] = [];
  for (const block of content) {
    if (block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    } else if (block.type === "image" && isRecord(block.source)) {
      const mediaType =
        block.source.type === "base64" && typeof block.source.media_type === "string"
          ? block.source.media_type
          : "image";
      parts.push(`[Image: ${mediaType}]`);
    } else if (block.type === "tool_reference" && typeof block.tool_name === "string") {
      parts.push(`[Tool reference: ${block.tool_name}]`);
    } else if (block.type === "search_result") {
      const title = typeof block.title === "string" ? block.title : "search result";
      const source = typeof block.source === "string" ? ` (${block.source})` : "";
      const nested = Array.isArray(block.content)
        ? contentToText(block.content.filter(isRecord))
        : "";
      parts.push(`${title}${source}${nested ? `\n${nested}` : ""}`);
    } else if (block.type === "document") {
      const title = typeof block.title === "string" ? block.title : "document";
      parts.push(`[Document: ${title}]`);
    }
  }
  return parts.join("\n");
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asRecord(value: unknown): Record<string, unknown> {
  if (isRecord(value)) {
    return value;
  }
  if (Array.isArray(value)) {
    return Object.fromEntries(value.entries());
  }
  return {};
}

export function asString(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  // // For exception
  // if (value instanceof Error) {
  //   return value.message
  // }

  return String(value);
}

export function asErrorString(value: unknown): string {
  if (value instanceof Error) {
    return value.message;
  }
  return asString(value);
}

export function isObject(value: unknown) {
  return typeof value === "object" && value !== null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function toTry<T extends (...args: any) => any>(fn: T, ctx?: ThisParameterType<T>) {
  if (typeof fn !== "function") {
    return fn;
  }
  return function (this: ThisParameterType<T>, ...args: Parameters<T>): ReturnType<T> | undefined {
    let ret: ReturnType<T>;
    try {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      ret = ctx ? fn.call(ctx, ...args) : fn.call(this, ...args);
    } catch (err) {
      log.error({ err }, "utils operation failed");
      return undefined;
    }
    return ret;
  };
}

export const safeJSONParse = toTry(JSON.parse, JSON);

export function asError(err: unknown) {
  if (err instanceof Error) {
    return err;
  }
  return new Error(String(err));
}

export function intArg(args: Record<string, unknown>, key: string, fallback: number): number {
  const v = args[key];
  if (typeof v === "number") {
    return Math.floor(v);
  }

  if (typeof v === "string") {
    const n = Number.parseInt(v, 10);
    return Number.isNaN(n) ? fallback : n;
  }

  return fallback;
}
export function strList(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.filter((v): v is string => typeof v === "string");
  }
  return [];
}

export function strArg(args: Record<string, unknown>, key: string, fallback?: string): string {
  const v = args[key];
  if (typeof v === "string") {
    return v;
  }

  return fallback ?? "";
}

export function boolArg(args: Record<string, unknown>, key: string, fallback?: boolean): boolean {
  const v = args[key];
  if (typeof v === "boolean") {
    return v;
  }

  return fallback ?? Boolean(v);
}

export function formatToolArgs(args: Record<string, unknown>): string {
  if (args.command) {
    return truncate(strArg(args, "command"), 80);
  }
  if (args.file_path) {
    return truncate(strArg(args, "file_path"), 80);
  }
  if (args.pattern) {
    return truncate(strArg(args, "pattern"), 80);
  }
  if (args.description) {
    return truncate(strArg(args, "description"), 80);
  }
  return "";
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

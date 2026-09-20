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

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

import { parse, z } from "zod";

import { createChildLogger } from "@/logger/index.js";

const log = createChildLogger({ module: "history" });

export const MAX_HISTORY_ENTRIES = 200;
const FILENAME = "prompt_history.jsonl";

const JSONLSchema = z.looseObject({ text: z.string() });
export function load(dir: string): string[] {
  const filePath = join(dir, FILENAME);
  if (!existsSync(filePath)) {
    return [];
  }

  try {
    const content = readFileSync(filePath, "utf-8");
    return content
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        try {
          const entry: unknown = JSON.parse(line);
          const { text } = parse(JSONLSchema, entry);
          return text;
        } catch (err) {
          log.error({ err }, "parse history line failed");
          return "";
        }
      })
      .filter(Boolean)
      .slice(-MAX_HISTORY_ENTRIES);
  } catch (err2) {
    log.error({ err: err2 }, "load history failed");
    return [];
  }
}

export function append(dir: string, text: string): string[] {
  const filePath = join(dir, FILENAME);
  mkdirSync(dir, { recursive: true });

  const entries = load(dir);

  if (entries.length === 0 || entries[entries.length - 1] !== text) {
    entries.push(text);
  }
  const retained = entries.slice(-MAX_HISTORY_ENTRIES);
  const lines = retained.map((entry) => JSON.stringify({ text: entry })).join("\n") + "\n";
  writeFileSync(filePath, lines, "utf-8");
  return retained;
}

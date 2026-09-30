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
  const lines =
    retained.map((entry) => JSON.stringify({ text: entry })).join("\n") + "\n";
  writeFileSync(filePath, lines, "utf-8");
  return retained;
}

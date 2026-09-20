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

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { join, dirname } from "path";

import { safeParse, z } from "zod";

import { createChildLogger } from "@/logger/index.js";
import { isRecord } from "@/utils/index.js";

const log = createChildLogger({ module: "commands" });

const UsageEntrySchema = z.object({
  usageCount: z.coerce.number(),
  lastUsedAt: z.coerce.number(),
});

type UsageEntry = z.infer<typeof UsageEntrySchema>;

export class CommandUsageTracker {
  private usage = new Map<string, UsageEntry>();
  private filePath: string;

  constructor(workDir: string) {
    const dir = join(workDir, ".yukino");
    this.filePath = join(dir, "command_usage.json");
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    this.load();
  }

  record(name: string): void {
    const existing = this.usage.get(name);
    this.usage.set(name, {
      usageCount: (existing?.usageCount ?? 0) + 1,
      lastUsedAt: Date.now(),
    });
    this.save();
  }

  getScore(name: string): number {
    const entry = this.usage.get(name);
    if (!entry) {
      return 0;
    }
    const daysSince = (Date.now() - entry.lastUsedAt) / (1000 * 60 * 60 * 24);
    const recency = Math.pow(0.5, daysSince / 7);
    return entry.usageCount * Math.max(recency, 0.1);
  }

  getRecentlyUsed(limit = 5): string[] {
    return [...this.usage.entries()]
      .map(([name, _entry]) => ({ name, score: this.getScore(name) }))
      .filter((e) => e.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((e) => e.name);
  }

  private load(): void {
    try {
      const data: unknown = JSON.parse(readFileSync(this.filePath, "utf-8"));
      if (!isRecord(data)) {
        return;
      }
      for (const [name, entry] of Object.entries(data)) {
        const { data, success } = safeParse(UsageEntrySchema, entry);
        if (success) {
          this.usage.set(name, data);
        }
      }
    } catch {
      // log.error({ err }, "commands operation failed");
      // file doesn't exist yet
    }
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      writeFileSync(
        this.filePath,
        JSON.stringify(Object.fromEntries(this.usage), null, 2),
      );
    } catch (err) {
      log.error({ err }, "commands operation failed");
      // ignore write errors
    }
  }
}

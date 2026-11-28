import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import pino from "pino";
import { expect, it, vi } from "vitest";

import { closeLogger, initLogger } from "@/logger/index.js";

it("drains pending writes and closes destinations safely across logger reinitialization", async () => {
  const directory = mkdtempSync(join(tmpdir(), "yukino-logger-lifecycle-"));
  const original = pino.destination;
  const destinations: ReturnType<typeof pino.destination>[] = [];
  const spy = vi.spyOn(pino, "destination").mockImplementation((options) => {
    const destination = original(options);
    destinations.push(destination);
    return destination;
  });
  try {
    const closures: Promise<unknown>[] = [];
    for (let index = 0; index < 10; index++) {
      const logger = initLogger({
        sessionId: `session-${index}`,
        mode: "terminal",
        logDir: directory,
        skipCleanup: true,
      });
      const destination = destinations.at(-1);
      if (!destination) {
        throw new Error("Logger destination was not created");
      }
      closures.push(once(destination, "close"));
      for (let entry = 0; entry < 20; entry++) {
        logger.warn({ entry, payload: "x".repeat(4096) }, "pending write");
      }
    }
    closeLogger();
    closeLogger();
    await Promise.all(closures);
    for (let index = 0; index < 10; index++) {
      const entries = readFileSync(
        join(directory, `session-${index}.jsonl`),
        "utf8",
      )
        .trim()
        .split("\n")
        .map((line: string): unknown => JSON.parse(line));
      expect(entries).toEqual(
        Array.from({ length: 20 }, (_, entry): unknown =>
          expect.objectContaining({ entry }),
        ),
      );
    }
  } finally {
    closeLogger();
    spy.mockRestore();
    rmSync(directory, { recursive: true, force: true });
  }
});

import { randomUUID } from "node:crypto";
import { mkdirSync, openSync } from "node:fs";
import { readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";

import pino, { type Logger } from "pino";

const retentionMs = 30 * 24 * 60 * 60 * 1000;
const logFilePattern = /^app-[\dT.Z-]+-[\da-f]{8}\.jsonl$/u;
const secretKeys = [
  "api_key",
  "apiKey",
  "token",
  "access_token",
  "accessToken",
  "refresh_token",
  "refreshToken",
  "password",
  "authorization",
  "Authorization",
  "cookie",
  "Cookie",
];

export function redactLogText(text: string): string {
  return text
    .replace(/\bBearer\s+[^\s"'<>]+/giu, "Bearer [Redacted]")
    .replace(
      /(["']?\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|authorization)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;&}]+)/giu,
      "$1[Redacted]",
    )
    .replace(/([?&]key=)[^&#\s]+/giu, "$1[Redacted]")
    .replace(/([a-z][a-z\d+.-]*:\/\/)[^/\s@]+@/giu, "$1[Redacted]@");
}

function serializeError(error: unknown, depth = 0): Record<string, unknown> {
  if (!(error instanceof Error)) {
    return {
      message:
        typeof error === "string"
          ? redactLogText(error)
          : "Non-Error rejection",
      type: typeof error,
    };
  }
  return {
    type: redactLogText(error.name),
    message: redactLogText(error.message),
    stack: error.stack ? redactLogText(error.stack) : undefined,
    code:
      "code" in error &&
      (typeof error.code === "string" || typeof error.code === "number")
        ? error.code
        : undefined,
    cause:
      error.cause !== undefined && depth < 5
        ? serializeError(error.cause, depth + 1)
        : undefined,
  };
}

async function pruneLogs(directory: string): Promise<void> {
  const cutoff = Date.now() - retentionMs;
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isFile() && logFilePattern.test(entry.name)) {
      const path = join(directory, entry.name);
      try {
        if ((await stat(path)).mtimeMs < cutoff) {
          await unlink(path);
        }
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !("code" in error) ||
          error.code !== "ENOENT"
        ) {
          throw error;
        }
      }
    }
  }
}

interface AppLogging {
  logger: Logger;
  filePath: string | null;
  flush: () => void;
  close: () => Promise<void>;
}

export function createAppLogger({
  directory,
  version,
  level = "info",
  console: consoleEnabled = false,
}: {
  directory: string;
  version: string;
  level?: string;
  console?: boolean;
}): AppLogging {
  const resolvedLevel = Object.hasOwn(pino.levels.values, level)
    ? level
    : "info";
  const options: pino.LoggerOptions = {
    name: "yukino-app",
    level: resolvedLevel,
    base: { pid: process.pid, version, platform: process.platform },
    timestamp: pino.stdTimeFunctions.isoTime,
    serializers: { err: (error: unknown) => serializeError(error) },
    redact: {
      paths: secretKeys.flatMap((key) => [key, `*.${key}`, `*.*.${key}`]),
      censor: "[Redacted]",
    },
  };
  const fallback = pino(options, pino.destination({ dest: 2, sync: true }));
  let destination: ReturnType<typeof pino.destination>;
  const timestamp = new Date().toISOString().replaceAll(":", "-");
  const filePath = join(
    directory,
    `app-${timestamp}-${process.pid}-${randomUUID().slice(0, 8)}.jsonl`,
  );
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    destination = pino.destination({
      dest: openSync(filePath, "ax", 0o600),
      sync: false,
    });
  } catch (err) {
    fallback.error({ err }, "Could not open the log file; using stderr");
    return {
      logger: fallback,
      filePath: null,
      flush: () => {
        fallback.flush();
      },
      close: async () => {
        fallback.flush();
      },
    };
  }
  destination.on("error", (err: Error) => {
    fallback.error({ err }, "Log file write failed");
  });
  const logger = pino(
    options,
    consoleEnabled
      ? pino.multistream([
          { stream: destination, level: resolvedLevel },
          { stream: process.stderr, level: resolvedLevel },
        ])
      : destination,
  );
  if (resolvedLevel !== level) {
    logger.warn("Invalid YUKINO_LOG_LEVEL; using info");
  }
  const cleanup = pruneLogs(directory).catch((err: unknown) => {
    logger.warn({ err }, "Could not remove expired logs");
  });
  let closed = false;
  let closing: Promise<void> | undefined;
  destination.once("close", () => {
    closed = true;
  });
  return {
    logger,
    filePath,
    flush: () => {
      if (!closed) {
        try {
          destination.flushSync();
        } catch (err) {
          fallback.error({ err }, "Could not flush application logs");
        }
      }
    },
    close: () =>
      (closing ??= (async () => {
        await cleanup;
        await new Promise<void>((resolve, reject) => {
          destination.once("close", resolve);
          destination.once("error", reject);
          destination.end();
        });
      })()),
  };
}

export function withIpcLogging<Args extends unknown[], Result>(
  logger: Logger,
  channel: string,
  handler: (...args: Args) => Result | PromiseLike<Result>,
): (...args: Args) => Promise<Result> {
  return async (...args) => {
    const started = performance.now();
    try {
      const result = await handler(...args);
      logger.debug(
        { channel, durationMs: Math.round(performance.now() - started) },
        "IPC request completed",
      );
      return result;
    } catch (err) {
      logger.error(
        { err, channel, durationMs: Math.round(performance.now() - started) },
        "IPC request failed",
      );
      throw err;
    }
  };
}

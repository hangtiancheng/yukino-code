import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createAppLogger, withIpcLogging } from "@main/logger.ts";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "yukino-app-logs-"));
  return {
    directory,
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

async function entries(
  path: string | null,
): Promise<Record<string, unknown>[]> {
  assert.ok(path);
  const content = await readFile(path, "utf8");
  return content
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

void test("Pino persists structured child logs, filters levels and flushes before closing", async () => {
  const { directory, cleanup } = await fixture();
  const logging = createAppLogger({
    directory,
    version: "test",
    level: "info",
  });
  try {
    const log = logging.logger.child({
      component: "agent",
      sessionId: "session",
    });
    log.debug("Hidden debug entry");
    log.info({ durationMs: 12 }, "Run complete");
    log.error(
      {
        err: new Error("Request failed", {
          cause: new Error("Connection reset"),
        }),
      },
      "Run failed",
    );
    await logging.close();
    await logging.close();
    logging.flush();
    const lines = await entries(logging.filePath);
    assert.equal(lines.length, 2);
    assert.equal(lines[0].name, "yukino-app");
    assert.equal(lines[0].component, "agent");
    assert.equal(lines[0].sessionId, "session");
    assert.equal(lines[0].durationMs, 12);
    assert.equal(lines[0].version, "test");
    assert.equal(typeof lines[0].time, "string");
    const error = lines[1].err as {
      type: string;
      message: string;
      stack: string;
      cause: { message: string };
    };
    assert.equal(error.type, "Error");
    assert.equal(error.message, "Request failed");
    assert.match(error.stack, /Request failed/);
    assert.equal(error.cause.message, "Connection reset");
  } finally {
    await logging.close();
    await cleanup();
  }
});

void test("logs redact credentials and discard arbitrary error payloads", async () => {
  const { directory, cleanup } = await fixture();
  const logging = createAppLogger({ directory, version: "test" });
  try {
    const err = Object.assign(
      new Error(
        "api_key=secret-one Authorization: Bearer secret-two https://user:secret-three@example.com?token=secret-four&key=secret-five",
      ),
      {
        request: { body: "private-prompt", api_key: "secret-six" },
        response: { body: "private-source-code" },
      },
    );
    logging.logger.error(
      {
        err,
        apiKey: "secret-seven",
        provider: { api_key: "secret-eight" },
        request: {
          headers: { authorization: "secret-nine", cookie: "secret-ten" },
        },
      },
      "Provider failed",
    );
    await logging.close();
    assert.ok(logging.filePath);
    const content = await readFile(logging.filePath, "utf8");
    assert.doesNotMatch(content, /secret-|private-prompt|private-source-code/);
    assert.match(content, /\[Redacted\]/);
    assert.match(content, /Provider failed/);
  } finally {
    await logging.close();
    await cleanup();
  }
});

void test("IPC logging preserves results and errors without recording arguments or responses", async () => {
  const { directory, cleanup } = await fixture();
  const logging = createAppLogger({
    directory,
    version: "test",
    level: "debug",
  });
  try {
    const result = { api_key: "result-secret" };
    const success = withIpcLogging(
      logging.logger,
      "yukino:save-provider",
      (_input: string) => result,
    );
    assert.equal(await success("input-secret"), result);
    const error = new Error("Connection refused");
    const failure = withIpcLogging(
      logging.logger,
      "workspace:save",
      async (_content: string) => {
        throw error;
      },
    );
    await assert.rejects(
      failure("private-file-content"),
      (cause: unknown) => cause === error,
    );
    await logging.close();
    const lines = await entries(logging.filePath);
    assert.deepEqual(
      lines.map((line) => line.channel),
      ["yukino:save-provider", "workspace:save"],
    );
    assert.deepEqual(
      lines.map((line) => line.level),
      [20, 50],
    );
    assert.ok(lines.every((line) => typeof line.durationMs === "number"));
    assert.doesNotMatch(
      JSON.stringify(lines),
      /input-secret|result-secret|private-file-content/,
    );
  } finally {
    await logging.close();
    await cleanup();
  }
});

void test("each launch gets a private file and cleanup only removes expired app logs", async () => {
  const { directory, cleanup } = await fixture();
  const expired = join(
    directory,
    "app-2000-01-01T00-00-00.000Z-1-12345678.jsonl",
  );
  const unrelated = join(directory, "important.jsonl");
  await writeFile(expired, "old log");
  await writeFile(unrelated, "keep");
  await utimes(expired, new Date(0), new Date(0));
  await utimes(unrelated, new Date(0), new Date(0));
  const first = createAppLogger({ directory, version: "test" });
  const second = createAppLogger({ directory, version: "test" });
  try {
    first.logger.info("First launch");
    second.logger.info("Second launch");
    await first.close();
    await second.close();
    assert.notEqual(first.filePath, second.filePath);
    const names = await readdir(directory);
    assert.equal(names.includes("important.jsonl"), true);
    assert.equal(
      names.includes("app-2000-01-01T00-00-00.000Z-1-12345678.jsonl"),
      false,
    );
    assert.equal(names.length, 3);
    if (process.platform !== "win32") {
      assert.ok(first.filePath);
      assert.equal((await stat(first.filePath)).mode & 0o777, 0o600);
    }
  } finally {
    await first.close();
    await second.close();
    await cleanup();
  }
});

void test("unavailable log directories preserve app behavior and respect silent logging", async () => {
  const { directory, cleanup } = await fixture();
  const blocked = join(directory, "file");
  await writeFile(blocked, "not a directory");
  const logging = createAppLogger({
    directory: blocked,
    version: "test",
    level: "silent",
  });
  try {
    assert.equal(logging.filePath, null);
    assert.equal(logging.logger.level, "silent");
    const request = withIpcLogging(logging.logger, "test", () => 42);
    assert.equal(await request(), 42);
    logging.flush();
  } finally {
    await logging.close();
    await cleanup();
  }
});

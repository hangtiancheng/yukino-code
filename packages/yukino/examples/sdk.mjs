import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const watchedSignals = [
  "SIGINT",
  "SIGTERM",
  "exit",
  "uncaughtException",
  "unhandledRejection",
];
const handlersBefore = watchedSignals.map((signal) =>
  process.listenerCount(signal),
);
const { createAgentSession } = await import("@yukino.js/yukino/sdk");
assert.deepEqual(
  watchedSignals.map((signal) => process.listenerCount(signal)),
  handlersBefore,
);

const directory = await mkdtemp(join(tmpdir(), "yukino-sdk-example-"));
const usage = {
  inputTokens: 1,
  outputTokens: 1,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0,
};
let calls = 0;
let release;
let started;
const gate = new Promise((resolve) => {
  release = resolve;
});
const ready = new Promise((resolve) => {
  started = resolve;
});
const client = {
  setSystemPrompt() {},
  async *stream() {
    calls += 1;
    if (calls === 2) {
      started();
      await gate;
    }
    yield { type: "text_delta", text: `answer ${calls}` };
    yield { type: "stream_end", stopReason: "end_turn", usage };
  },
};
const events = [];
let session;
try {
  ({ session } = await createAgentSession({
    cwd: directory,
    client,
    persist: false,
    tools: [],
    onPermissionRequest: async () => "deny",
  }));
  const unsubscribe = session.subscribe((event) => {
    events.push(event);
  });
  assert.equal((await session.prompt("first")).status, "completed");
  const pending = session.prompt("second");
  await ready;
  const queued = session.followUp("third");
  assert.equal(session.getQueue()[0].text, "third");
  release();
  await Promise.all([pending, queued.completion, session.waitForIdle()]);
  const entries = session.getEntries();
  const firstReply = entries.find(
    (entry) => entry.message.content === "answer 1",
  );
  assert.ok(firstReply);
  await session.navigate(firstReply.entryId);
  await session.prompt("alternate branch");
  session.setName("SDK example");
  session.setLabel(firstReply.entryId, "checkpoint");
  assert.ok(session.getTree().length);
  const exported = session.export({ scope: "tree", format: "jsonl" });
  assert.ok(exported.includes("third"));
  assert.ok(events.some((event) => event.type === "session_changed"));
  assert.ok(events.some((event) => event.type === "run_settled"));
  unsubscribe();
  process.stdout.write(
    JSON.stringify({
      status: "ok",
      calls,
      events: events.length,
      attempts: session.getStats().attempts,
    }) + "\n",
  );
} finally {
  await session?.dispose();
  await session?.dispose();
  assert.deepEqual(
    watchedSignals.map((signal) => process.listenerCount(signal)),
    handlersBefore,
  );
  await rm(directory, { recursive: true, force: true });
}

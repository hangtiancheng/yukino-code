import { once } from "node:events";
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import { reply, rpcCli, toolReply } from "./fixtures/rpc-cli.js";

import { RPC_COMMANDS, RPC_MAX_LINE_BYTES } from "@/rpc/constants.js";
import type { RpcMessage } from "@/rpc/protocol.js";

function eventIs(message: RpcMessage, type: string): boolean {
  return (
    message.type === "event" &&
    z.object({ type: z.literal(type) }).safeParse(message.event).success
  );
}
function settled(message: RpcMessage, commandId: string): boolean {
  return (
    message.type === "event" &&
    message.commandId === commandId &&
    z.object({ type: z.literal("command_completed") }).safeParse(message.event)
      .success
  );
}
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error("Local provider deadline exceeded"));
        }, 10_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

const initialized = (message: RpcMessage) => eventIs(message, "initialized");

describe("RPC real CLI stdio with an isolated local provider", () => {
  it("delivers image-only steering and attached follow-ups through real stdio", async () => {
    let release!: (response: ServerResponse) => void;
    const started = new Promise<ServerResponse>((resolve) => {
      release = resolve;
    });
    const f = await rpcCli((_request, response, number) => {
      if (number === 1) {
        release(response);
      } else {
        reply(response, { role: "assistant", content: "ATTACHED_OK" });
      }
    });
    try {
      await f.next(initialized);
      const first = f.send("prompt", { text: "inspect" });
      const response = await bounded(started);
      const attachments = [
        {
          type: "image",
          source: {
            type: "base64",
            media_type: "image/png",
            data: "aW1hZ2U=",
          },
        },
      ];
      await expect(
        f.query("steer", { text: "", attachments: [{}] }),
      ).rejects.toThrow();
      const receipt = z
        .object({ inputId: z.string() })
        .parse(await f.query("steer", { text: "", attachments }));
      expect(await f.query("get_queue")).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: receipt.inputId, attachments }),
        ]),
      );
      const follow = z.object({ inputId: z.string() }).parse(
        await f.query("follow_up", {
          text: "attachment next",
          attachments,
        }),
      );
      reply(response, { role: "assistant", content: "FIRST_OK" });
      await f.next((message) => settled(message, first));
      await f.next((message) => {
        if (message.type !== "event") {
          return false;
        }
        const event = z
          .object({
            type: z.literal("run_settled"),
            payload: z.object({
              messages: z.array(
                z.object({
                  userInput: z.object({ id: z.string() }).optional(),
                }),
              ),
            }),
          })
          .safeParse(message.event);
        return (
          event.success &&
          event.data.payload.messages.some(
            (item) => item.userInput?.id === follow.inputId,
          )
        );
      });
      expect(f.requests).toHaveLength(3);
      expect(JSON.stringify(f.requests[0])).not.toContain("image_url");
      expect(JSON.stringify(f.requests[1])).toContain(
        "data:image/png;base64,aW1hZ2U=",
      );
      expect(JSON.stringify(f.requests[2])).toContain("attachment next");
      f.assertClean();
    } finally {
      await f.dispose();
    }
  });

  it("preserves prompt/ack/settled, split UTF-8, concurrent IDs, modes, and deferred follow-up", async () => {
    let received!: (response: ServerResponse) => void;
    const firstRequest = new Promise<ServerResponse>((resolve) => {
      received = resolve;
    });
    const f = await rpcCli((_request, response, number) => {
      if (number === 1) {
        received(response);
      } else {
        reply(response, { role: "assistant", content: "DEFERRED_OK" });
      }
    });
    try {
      await f.next(initialized);
      expect(await f.query("get_commands")).toEqual(
        expect.arrayContaining([...RPC_COMMANDS]),
      );
      expect(await f.query("get_queue_modes")).toEqual({
        steering: "all",
        followUp: "one-at-a-time",
      });
      await f.query("set_queue_mode", { kind: "steer", mode: "one-at-a-time" });
      await f.query("set_queue_mode", { kind: "follow_up", mode: "all" });
      expect(await f.query("get_queue_modes")).toEqual({
        steering: "one-at-a-time",
        followUp: "all",
      });
      await f.query("set_queue_mode", {
        kind: "follow_up",
        mode: "one-at-a-time",
      });
      const bytes = Buffer.from(
        JSON.stringify({
          version: 1,
          type: "request",
          commandId: "golden-prompt",
          command: "prompt",
          args: { text: "雪 golden prompt" },
        }) + "\n",
      );
      const split = bytes.indexOf(Buffer.from("雪")) + 1;
      f.child.stdin.write(bytes.subarray(0, split));
      f.child.stdin.write(bytes.subarray(split));
      const ack = await f.next(
        (message) =>
          message.type === "response" && message.commandId === "golden-prompt",
      );
      const stateBefore = z
        .object({ sessionId: z.string() })
        .parse(await f.query("get_state"));
      expect(ack).toEqual({
        version: 1,
        type: "response",
        commandId: "golden-prompt",
        success: true,
        result: { accepted: true, sessionId: stateBefore.sessionId },
      });
      const response = await bounded(firstRequest);
      f.send(
        "prompt",
        { text: "do not replay a pending command" },
        "golden-prompt",
      );
      expect(
        await f.next(
          (message) =>
            message.type === "response" &&
            message.commandId === "golden-prompt" &&
            !message.success,
        ),
      ).toMatchObject({ error: { code: "invalid_request" } });
      expect(f.requests).toHaveLength(1);
      const [state, retry, followUp] = await Promise.all([
        f.query("get_state"),
        f.query("get_retry_state"),
        f.query("follow_up", { text: "deferred follow-up" }),
      ]);
      expect(state).toMatchObject({ initialized: true, busy: true });
      expect(retry).toBeNull();
      const receipt = z.object({ inputId: z.string() }).parse(followUp);
      expect(await f.query("get_queue")).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: receipt.inputId,
            kind: "followUp",
            text: "deferred follow-up",
            state: "queued",
          }),
        ]),
      );
      expect(f.requests).toHaveLength(1);
      expect(JSON.stringify(f.requests[0].messages)).toContain(
        "雪 golden prompt",
      );
      reply(response, { role: "assistant", content: "GOLDEN_OK" });
      expect(
        await f.next((message) => settled(message, "golden-prompt")),
      ).toMatchObject({
        version: 1,
        type: "event",
        commandId: "golden-prompt",
        event: {
          type: "command_completed",
          command: "prompt",
          result: { status: "completed", text: "GOLDEN_OK" },
        },
      });
      await f.next(
        (message) =>
          message.type === "event" &&
          z
            .object({
              type: z.literal("run_settled"),
              payload: z.object({ text: z.literal("DEFERRED_OK") }),
            })
            .safeParse(message.event).success,
      );
      expect(f.requests).toHaveLength(2);
      expect(JSON.stringify(f.requests[1].messages)).toContain(
        "deferred follow-up",
      );
      expect(await f.query("get_queue")).toEqual([]);
      f.assertClean();
      f.child.stdin.end();
      expect(await bounded(f.closed)).toEqual({ code: 0, signal: null });
      f.assertClean();
    } finally {
      await f.dispose();
    }
  }, 30_000);

  it("observes provider retry reason/delay and reset without a retry command", async () => {
    const f = await rpcCli((_request, response, number) => {
      if (number === 1) {
        response.writeHead(429, {
          "content-type": "application/json",
          "retry-after": "1",
        });
        response.end(
          JSON.stringify({
            error: { message: "local rate limit", type: "rate_limit_error" },
          }),
        );
      } else {
        reply(response, { role: "assistant", content: "RETRY_OK" });
      }
    });
    try {
      await f.next(initialized);
      expect(await f.query("get_retry_state")).toBeNull();
      const commandId = f.send("prompt", { text: "retry locally" });
      await f.next((message) => eventIs(message, "retry"));
      expect(await f.query("get_retry_state")).toEqual({
        reason: "rate limited",
        delay: 1000,
      });
      await f.next((message) => settled(message, commandId));
      expect(await f.query("get_retry_state")).toBeNull();
      expect(f.requests).toHaveLength(2);
      const id = f.send("retry");
      expect(
        await f.next(
          (message) =>
            message.type === "response" &&
            !message.success &&
            message.commandId === null,
        ),
      ).toMatchObject({ error: { code: "invalid_request" } });
      expect(
        f.messages.some(
          (message) => message.type === "response" && message.commandId === id,
        ),
      ).toBe(false);
      expect(f.requests).toHaveLength(2);
      f.assertClean();
    } finally {
      await f.dispose();
    }
  }, 30_000);

  it("clears retry state on cancellation without replaying the request", async () => {
    const f = await rpcCli((_request, response) => {
      response.writeHead(429, {
        "content-type": "application/json",
        "retry-after": "10",
      });
      response.end(
        JSON.stringify({
          error: { message: "local retry wait", type: "rate_limit_error" },
        }),
      );
    });
    try {
      await f.next(initialized);
      const commandId = f.send("prompt", { text: "cancel retry delay" });
      await f.next((message) => eventIs(message, "retry"));
      expect(await f.query("get_retry_state")).toEqual({
        reason: "rate limited",
        delay: 10_000,
      });
      await f.query("abort");
      expect(
        await f.next((message) => settled(message, commandId)),
      ).toMatchObject({ event: { result: { status: "aborted" } } });
      expect(await f.query("get_retry_state")).toBeNull();
      expect(f.requests).toHaveLength(1);
      f.assertClean();
    } finally {
      await f.dispose();
    }
  }, 30_000);

  it("queries/stops CodeMode and resumes warming without enabling default-off requests", async () => {
    const f = await rpcCli(
      (_request, response) => {
        toolReply(
          response,
          "CodeMode",
          { code: "while (true) {}" },
          "owned-code",
        );
      },
      {
        args: ["--no-project-resources", "--tools", "CodeMode"],
        config: { code_mode: { mode: "on", inline_budget: 12000 } },
      },
    );
    try {
      await f.next(initialized);
      expect(await f.query("get_code_mode")).toEqual({
        activeToolCallIds: [],
        foregroundToolsRunning: false,
      });
      const initialWarming = z
        .object({ state: z.string() })
        .parse(await f.query("get_warming_state"));
      expect(["scheduled", "running"]).not.toContain(initialWarming.state);
      expect(f.requests).toHaveLength(0);
      await f.query("stop_warming");
      expect(await f.query("get_warming_state")).toMatchObject({
        state: "paused",
        skipReason: "user_stopped",
      });
      await f.query("resume_warming");
      expect(await f.query("get_warming_state")).not.toMatchObject({
        state: "running",
      });
      expect(f.requests).toHaveLength(0);
      const commandId = f.send("prompt", { text: "run owned CodeMode" });
      await f.next((message) => eventIs(message, "tool_use"));
      expect(await f.query("get_code_mode")).toMatchObject({
        activeToolCallIds: ["owned-code"],
      });
      await f.query("stop_code_mode");
      expect(
        await f.next((message) => settled(message, commandId)),
      ).toMatchObject({ event: { result: { status: "aborted" } } });
      expect(await f.query("get_code_mode")).toEqual({
        activeToolCallIds: [],
        foregroundToolsRunning: false,
      });
      await f.query("resume_warming");
      await f.query("stop_warming");
      expect(f.requests).toHaveLength(1);
      f.assertClean();
    } finally {
      await f.dispose();
    }
  }, 30_000);

  it.each(["allow", "deny"])(
    "keeps real write permission replies single-use (%s)",
    async (answer) => {
      const f = await rpcCli(
        (_request, response, number) => {
          if (number === 1) {
            toolReply(response, "WriteFile", {
              file_path: "owned.txt",
              content: "owned local output",
            });
          } else {
            reply(response, { role: "assistant", content: "PERMISSION_DONE" });
          }
        },
        { args: ["--no-project-resources", "--tools", "WriteFile"] },
      );
      try {
        await f.next(initialized);
        const commandId = f.send("prompt", {
          text: "write only in fixture cwd",
        });
        const interaction = await f.next(
          (message) =>
            message.type === "interaction" && message.kind === "permission",
        );
        if (interaction.type !== "interaction") {
          throw new Error("Expected permission interaction");
        }
        const args = {
          interactionId: interaction.interactionId,
          sessionId: interaction.sessionId,
          response: answer,
        };
        expect(await f.query("interaction_response", args)).toEqual({
          accepted: true,
        });
        const replay = f.send("interaction_response", args);
        expect(
          await f.next(
            (message) =>
              message.type === "response" && message.commandId === replay,
          ),
        ).toMatchObject({
          success: false,
          error: { code: "stale_interaction" },
        });
        await f.next((message) => settled(message, commandId));
        expect(existsSync(join(f.cwd, "owned.txt"))).toBe(answer === "allow");
        if (answer === "allow") {
          expect(await readFile(join(f.cwd, "owned.txt"), "utf8")).toBe(
            "owned local output",
          );
        }
        expect(f.requests).toHaveLength(2);
        f.assertClean();
      } finally {
        await f.dispose();
      }
    },
    30_000,
  );

  it("answers a real AskUser interaction without implicit approval", async () => {
    const f = await rpcCli(
      (_request, response, number) => {
        if (number === 1) {
          toolReply(response, "AskUserQuestion", {
            questions: [
              {
                question: "Choose locally?",
                options: [{ label: "No" }, { label: "Yes" }],
                multiSelect: false,
              },
            ],
          });
        } else {
          reply(response, { role: "assistant", content: "ASK_DONE" });
        }
      },
      { args: ["--no-project-resources", "--tools", "AskUserQuestion"] },
    );
    try {
      await f.next(initialized);
      const commandId = f.send("prompt", { text: "ask locally" });
      const interaction = await f.next(
        (message) =>
          message.type === "interaction" && message.kind === "ask_user",
      );
      if (interaction.type !== "interaction") {
        throw new Error("Expected AskUser interaction");
      }
      await f.query("interaction_response", {
        interactionId: interaction.interactionId,
        sessionId: interaction.sessionId,
        response: { "Choose locally?": "No" },
      });
      await f.next((message) => settled(message, commandId));
      expect(JSON.stringify(f.requests[1].messages)).toContain("No");
      f.assertClean();
    } finally {
      await f.dispose();
    }
  }, 30_000);

  it("requires a single-use real plan approval after writing only the temporary plan", async () => {
    let planPath = "";
    const f = await rpcCli(
      async (_request, response, number) => {
        if (number === 1) {
          const plans = join(f.home, ".yukino", "plans");
          const files = await readdir(plans);
          expect(files).toHaveLength(1);
          planPath = join(plans, files[0]);
          toolReply(response, "ReadFile", { file_path: planPath }, "read-plan");
        } else if (number === 2) {
          toolReply(
            response,
            "WriteFile",
            {
              file_path: planPath,
              content: "Local plan only; do not execute work.",
            },
            "write-plan",
          );
        } else if (number === 3) {
          toolReply(response, "ExitPlanMode", {}, "exit-plan");
        } else {
          reply(response, { role: "assistant", content: "PLAN_READY" });
        }
      },
      {
        args: [
          "--no-project-resources",
          "--permission-mode",
          "plan",
          "--tools",
          "ReadFile,WriteFile,ExitPlanMode",
        ],
      },
    );
    try {
      await f.next(initialized);
      const commandId = f.send("prompt", { text: "prepare a local plan" });
      const interaction = await f.next(
        (message) =>
          message.type === "interaction" && message.kind === "plan_approval",
      );
      if (interaction.type !== "interaction") {
        throw new Error("Expected plan approval interaction");
      }
      expect(interaction.payload).toMatchObject({
        plan: "Local plan only; do not execute work.",
      });
      const args = {
        interactionId: interaction.interactionId,
        sessionId: interaction.sessionId,
        response: "deny",
      };
      await f.query("interaction_response", args);
      const replay = f.send("interaction_response", {
        ...args,
        response: "approve",
      });
      expect(
        await f.next(
          (message) =>
            message.type === "response" && message.commandId === replay,
        ),
      ).toMatchObject({ error: { code: "stale_interaction" } });
      await f.next((message) => settled(message, commandId));
      expect(f.requests.length).toBeLessThanOrEqual(4);
      expect(await readFile(planPath, "utf8")).toBe(
        "Local plan only; do not execute work.",
      );
      f.assertClean();
    } finally {
      await f.dispose();
    }
  }, 30_000);

  it("denies real project trust before initialization and rejects replay", async () => {
    const f = await rpcCli(undefined, {
      args: ["--no-tools"],
      projectConfig: { theme: "dark" },
    });
    try {
      const interaction = await f.next(
        (message) =>
          message.type === "interaction" && message.kind === "project_trust",
      );
      if (interaction.type !== "interaction") {
        throw new Error("Expected project trust interaction");
      }
      expect(f.messages.some(initialized)).toBe(false);
      const args = {
        interactionId: interaction.interactionId,
        sessionId: interaction.sessionId,
        response: "deny",
      };
      await f.query("interaction_response", args);
      await f.next(initialized);
      const replay = f.send("interaction_response", args);
      expect(
        await f.next(
          (message) =>
            message.type === "response" && message.commandId === replay,
        ),
      ).toMatchObject({ error: { code: "stale_interaction" } });
      expect(f.requests).toHaveLength(0);
      f.assertClean();
    } finally {
      await f.dispose();
    }
  }, 30_000);

  it("recovers after an oversized input and a genuinely paused stdout consumer", async () => {
    const f = await rpcCli();
    try {
      await f.next(initialized);
      f.child.stdin.write("x".repeat(RPC_MAX_LINE_BYTES + 1) + "\n");
      expect(
        await f.next(
          (message) => message.type === "response" && !message.success,
        ),
      ).toMatchObject({ error: { code: "invalid_request" } });
      const commandId = f.send("prompt", { text: "n".repeat(16 * 1024) });
      await f.next((message) => settled(message, commandId));
      f.child.stdout.pause();
      const ids: string[] = [];
      for (let index = 0; index < 48; index++) {
        ids.push(f.send("get_entries"));
      }
      await bounded(once(f.child.stdout, "readable"));
      f.child.stdout.resume();
      const responses = await Promise.all(
        ids.map((id) =>
          f.next(
            (message) =>
              message.type === "response" && message.commandId === id,
          ),
        ),
      );
      expect(responses).toHaveLength(48);
      expect(
        responses.every(
          (message) => message.type === "response" && message.success,
        ),
      ).toBe(true);
      expect(await f.query("get_state")).toMatchObject({
        initialized: true,
        busy: false,
      });
      f.assertClean();
    } finally {
      f.child.stdout.resume();
      await f.dispose();
    }
  }, 30_000);

  it.each(["abort", "EOF", "SIGINT", "SIGTERM"])(
    "cancels owned provider work cleanly on %s",
    async (action) => {
      let received!: (response: ServerResponse) => void;
      const firstRequest = new Promise<ServerResponse>((resolve) => {
        received = resolve;
      });
      const f = await rpcCli((_request, response) => {
        received(response);
      });
      try {
        await f.next(initialized);
        const commandId = f.send("prompt", { text: "wait for cancellation" });
        const response = await bounded(firstRequest);
        const disconnected = once(response, "close");
        if (action === "abort") {
          await f.query("abort");
          expect(
            await f.next((message) => settled(message, commandId)),
          ).toMatchObject({ event: { result: { status: "aborted" } } });
          expect(await f.query("get_retry_state")).toBeNull();
          expect(await f.query("get_state")).toMatchObject({ busy: false });
          f.child.stdin.end();
        } else if (action === "EOF") {
          f.child.stdin.end();
        } else {
          f.child.kill(action === "SIGINT" ? "SIGINT" : "SIGTERM");
        }
        await bounded(disconnected);
        expect(await bounded(f.closed), f.stderr()).toEqual({
          code: action === "SIGINT" ? 130 : action === "SIGTERM" ? 143 : 0,
          signal: null,
        });
        expect(f.requests).toHaveLength(1);
        f.assertClean();
      } finally {
        await f.dispose();
      }
    },
    30_000,
  );
});

describe("runtime control RPC coverage", () => {
  it("round trips safe settings, model discovery/cycling and resource reload through real stdio", async () => {
    const f = await rpcCli();
    try {
      await f.next(initialized);
      const settings = z.object({
        values: z.object({
          auto_compaction: z.boolean(),
          auto_retry: z.boolean(),
          display: z.object({
            output_padding: z.number(),
            show_thinking: z.boolean(),
          }),
          code_mode: z.object({ mode: z.string(), inline_budget: z.number() }),
        }),
        sources: z.array(z.object({ scope: z.string() })),
      });
      expect(
        settings.parse(await f.query("get_settings")).values.auto_retry,
      ).toBe(true);
      await expect(
        f.query("set_settings", { values: { api_key: "forbidden" } }),
      ).rejects.toThrow();
      await expect(
        f.query("set_auto_retry", { enabled: "false" }),
      ).rejects.toThrow();
      await f.query("set_settings", {
        values: {
          display: { output_padding: 2, show_thinking: false },
          code_mode: { mode: "only", inline_budget: 0 },
        },
        persist: true,
      });
      await f.query("set_auto_compaction", { enabled: false });
      await f.query("set_auto_retry", { enabled: false });
      const models = z
        .array(z.object({ name: z.string(), model: z.string() }).loose())
        .parse(await f.query("get_available_models"));
      expect(models.map(({ name }) => name)).toEqual(["local"]);
      expect(models[0]).not.toHaveProperty("api_key");
      await f.query("cycle_model");
      await f.query("cycle_model", { direction: -1 });
      const level = await f.query("cycle_thinking");
      expect(typeof level).toBe("string");
      expect(await f.query("cycle_thinking", { direction: -1 })).toBe("off");
      const run = f.send("prompt", { text: "keep this history" });
      await f.next((message) => settled(message, run));
      const result = z
        .object({
          skills: z.number(),
          commands: z.number(),
          errors: z.array(z.unknown()),
        })
        .parse(await f.query("reload"));
      expect(result.errors).toEqual([]);
      expect(
        settings.parse(await f.query("get_settings")).values,
      ).toMatchObject({
        auto_retry: false,
        auto_compaction: false,
        display: { output_padding: 2, show_thinking: false },
        code_mode: { mode: "only", inline_budget: 0 },
      });
      expect(JSON.stringify(await f.query("get_messages"))).toContain(
        "keep this history",
      );
      expect(f.requests).toHaveLength(1);
      expect(await f.query("abort_retry")).toEqual({ aborted: false });
      f.assertClean();
    } finally {
      await f.dispose();
    }
  }, 30_000);
  it("aborts only a retry wait and subsequently delivers an already queued follow-up", async () => {
    const f = await rpcCli((_request, response, number) => {
      if (number === 1) {
        response.writeHead(429, {
          "content-type": "application/json",
          "retry-after": "60",
        });
        response.end(
          JSON.stringify({
            error: { message: "local rate limit", type: "rate_limit_error" },
          }),
        );
      } else {
        reply(response, { role: "assistant", content: "FOLLOW_UP_OK" });
      }
    });
    try {
      await f.next(initialized);
      const run = f.send("prompt", { text: "cancel wait" });
      await f.next((message) => eventIs(message, "retry"));
      await f.query("follow_up", { text: "queued after retry" });
      expect(await f.query("abort_retry")).toEqual({ aborted: true });
      expect(await f.next((message) => settled(message, run))).toMatchObject({
        event: { result: { status: "aborted", stopReason: "retry_aborted" } },
      });
      await f.next(
        (message) =>
          eventIs(message, "run_settled") &&
          JSON.stringify(message).includes("FOLLOW_UP_OK"),
      );
      expect(f.requests).toHaveLength(2);
      expect(await f.query("get_retry_state")).toBeNull();
      f.assertClean();
    } finally {
      await f.dispose();
    }
  }, 30_000);
});

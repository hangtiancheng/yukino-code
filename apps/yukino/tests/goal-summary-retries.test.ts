import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Agent } from "@yukino.js/agent";
import type { ProviderConfig } from "@yukino.js/config/provider-config.js";
import { ConversationManager } from "@yukino.js/conversation";
import { GoalManager } from "@yukino.js/goal";
import { AnthropicClient } from "@yukino.js/llm/anthropic.js";
import type { LLMClient } from "@yukino.js/llm/client.js";
import { RateLimitError, ServerError } from "@yukino.js/llm/errors.js";
import { OpenAIClient, OpenAICompatClient } from "@yukino.js/llm/openai.js";
import { PermissionChecker } from "@yukino.js/permissions";
import { ToolRegistry } from "@yukino.js/tools/registry.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let cwd: string;
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "yukino-goal-retries-"));
});
afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

function client(config: ProviderConfig): LLMClient {
  switch (config.protocol) {
    case "anthropic":
      return new AnthropicClient(config, "test system");
    case "openai":
      return new OpenAIClient(config, "test system");
    case "openai-compat":
      return new OpenAICompatClient(config, "test system");
  }
}

async function drain(client: LLMClient): Promise<void> {
  const conversation = new ConversationManager();
  conversation.addUserMessage("Regular request");
  for await (const _event of client.stream(conversation, [])) {
    /* Consume the actual SDK request. */
  }
}

describe.each(["anthropic", "openai", "openai-compat"] as const)(
  "%s budget-summary HTTP retries",
  (protocol) => {
    it.each([429, 503])(
      "attempts a summary only once after HTTP %s and preserves regular retries",
      async (status) => {
        let requests = 0;
        const server = createServer((request, response) => {
          requests++;
          request.resume();
          response.writeHead(status, {
            "content-type": "application/json",
            "retry-after-ms": "1",
          });
          response.end(
            JSON.stringify({
              error: {
                type: status === 429 ? "rate_limit_error" : "api_error",
                message: "Simulated provider failure",
              },
            }),
          );
        });
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(0, "127.0.0.1", resolve);
        });
        try {
          const address = server.address();
          if (!address || typeof address === "string") {
            throw new Error("Expected a local TCP address");
          }
          const worker = client({
            name: "local",
            protocol,
            base_url: `http://127.0.0.1:${address.port}/v1`,
            api_key: "local-test-only",
            model: "test",
            reasoning: false,
          });
          const goal = new GoalManager(cwd, "one");
          goal.set("Finish verification", 1);
          goal.beginTurn();
          goal.addTokens(2);
          goal.endRun();
          const conversation = new ConversationManager();
          conversation.addUserMessage("Existing work");
          const agent = new Agent({
            client: worker,
            conversation,
            registry: new ToolRegistry(),
            checker: new PermissionChecker(cwd, "bypassPermissions"),
            cwd,
            sessionId: "one",
            goalManager: goal,
          });
          const events = [];
          for await (const event of agent.run()) {
            events.push(event);
          }
          const errorClass = status === 429 ? RateLimitError : ServerError;
          const lastEvent = events.at(-1);
          expect(
            lastEvent?.type === "error" ? lastEvent.error : undefined,
          ).toBeInstanceOf(errorClass);
          expect(events.some((event) => event.type === "retry")).toBe(false);
          expect(requests).toBe(1);
          expect(new GoalManager(cwd, "one").get()).toMatchObject({
            status: "budget_limited",
            budgetSummaryPending: false,
          });

          requests = 0;
          await expect(drain(worker)).rejects.toBeInstanceOf(errorClass);
          expect(requests).toBe(3);
        } finally {
          server.closeAllConnections();
          await new Promise<void>((resolve, reject) => {
            server.close((error) => {
              if (error) {
                reject(error);
              } else {
                resolve();
              }
            });
          });
        }
      },
    );
  },
);

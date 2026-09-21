/**
 * Live provider smoke test.
 *
 * Drives the real LLM clients (src/llm) against the providers configured in
 * ~/.yukino/config.yaml and verifies per-provider expectations over three
 * scenarios:
 *
 *   text  - plain streaming chat completion
 *   tool  - single-turn tool call (get_weather)
 *   image - multimodal user message with an inline base64 PNG
 *
 * Expectation matrix (from the operator's endpoint knowledge):
 *   ds-openai / ds-anthropic : all scenarios succeed (multimodal tolerated)
 *
 * Errors must always surface as classified LLMError subclasses - a raw SDK
 * error escaping stream() is itself a failure.
 *
 * This script hits real network endpoints with real credentials and is NOT
 * part of the vitest suite. Run it manually:
 *
 *   npx tsx tests/smoke-providers.ts                          # all providers
 *   npx tsx tests/smoke-providers.ts ds-openai ds-anthropic   # subset
 *   npx tsx tests/smoke-providers.ts --only=text,image        # scenario subset
 */

import sharp from "sharp";

import { loadConfig, type ProviderConfig } from "@/config/index.js";
import { ConversationManager } from "@/conversation/index.js";
import { createClient } from "@/llm/client.js";
import { LLMError } from "@/llm/errors.js";
import type { StreamEvent, UsageInfo } from "@/llm/events.js";
import type { ToolSchema } from "@/tools/types.js";

type ScenarioName = "text" | "tool" | "image";

const ALL_SCENARIOS: ScenarioName[] = ["text", "tool", "image"];

/** Per-scenario timeout; thinking-heavy models can take a while. */
const SCENARIO_TIMEOUT_MS = 120_000;

interface Expectation {
  /**
   * Whether the request should complete ("ok"), fail ("error"), or either
   * ("any" - for endpoints with observed nondeterministic gateway behavior;
   * graceful handling is still required in both branches).
   */
  outcome: "ok" | "error" | "any";
  /** Required error class name (e.g. AuthenticationError). Any LLMError when unset. */
  errorName?: string;
  /** Tool the model must call for the scenario to pass. */
  expectToolCall?: string;
  /** Human-readable rationale shown in the report. */
  note?: string;
}

const OK: Expectation = { outcome: "ok" };
const OK_TOOL: Expectation = { outcome: "ok", expectToolCall: "get_weather" };

/**
 * Known endpoints. Providers absent from this map get the healthy-endpoint
 * default so newly added config entries are still exercised.
 */
const EXPECTATIONS: Record<string, Record<ScenarioName, Expectation>> = {
  // DeepSeek gateways: full-featured, multimodal tolerated.
  "ds-openai": { text: OK, tool: OK_TOOL, image: OK },
  "ds-anthropic": { text: OK, tool: OK_TOOL, image: OK },
};

const DEFAULT_EXPECTATIONS: Record<ScenarioName, Expectation> = {
  text: OK,
  tool: OK_TOOL,
  image: OK,
};

const WEATHER_TOOL: ToolSchema = {
  name: "get_weather",
  description: "Get the current weather for a city.",
  input_schema: {
    type: "object",
    properties: {
      city: { type: "string", description: "City name" },
    },
    required: ["city"],
  },
};

const SYSTEM_PROMPT =
  "You are Yukino, a concise assistant used in an automated smoke test. " +
  "Follow each instruction exactly.";

interface AttemptResult {
  /** stream_end was received. */
  completed: boolean;
  text: string;
  textDeltas: number;
  thinkingChars: number;
  toolCalls: { name: string; args: Record<string, unknown> }[];
  stopReason?: string;
  usage?: UsageInfo;
  error?: { name: string; message: string; classified: boolean };
  elapsedMs: number;
}

/** Build a deterministic 32x32 solid red PNG for the multimodal scenario. */
async function makeRedPngBase64(): Promise<string> {
  const png = await sharp({
    create: {
      width: 32,
      height: 32,
      channels: 3,
      background: { r: 220, g: 20, b: 20 },
    },
  })
    .png()
    .toBuffer();
  return png.toString("base64");
}

function populateConversation(
  scenario: ScenarioName,
  conv: ConversationManager,
  pngBase64: string,
): ToolSchema[] {
  switch (scenario) {
    case "text": {
      conv.addUserMessage("Reply with exactly one word: PONG");
      return [];
    }
    case "tool": {
      conv.addUserMessage(
        'Call the get_weather tool with city set to "Paris". ' +
          "Use the tool; do not answer directly.",
      );
      return [WEATHER_TOOL];
    }
    case "image": {
      conv.addUserMessage([
        {
          type: "text",
          text: "What color is this image? Answer in one short sentence.",
        },
        {
          type: "image",
          source: {
            type: "base64",
            media_type: "image/png",
            data: pngBase64,
          },
        },
      ]);
      return [];
    }
  }
}

async function runScenario(
  provider: ProviderConfig,
  scenario: ScenarioName,
  pngBase64: string,
): Promise<AttemptResult> {
  const result: AttemptResult = {
    completed: false,
    text: "",
    textDeltas: 0,
    thinkingChars: 0,
    toolCalls: [],
    elapsedMs: 0,
  };
  const started = Date.now();
  const ac = new AbortController();
  const timer = setTimeout(() => {
    ac.abort();
  }, SCENARIO_TIMEOUT_MS);
  try {
    const client = await createClient(provider, SYSTEM_PROMPT);
    const conv = new ConversationManager();
    const tools = populateConversation(scenario, conv, pngBase64);
    const stream: AsyncGenerator<StreamEvent> = client.stream(
      conv,
      tools,
      ac.signal,
    );
    for await (const event of stream) {
      switch (event.type) {
        case "text_delta": {
          result.text += event.text;
          result.textDeltas++;
          break;
        }
        case "thinking_delta": {
          result.thinkingChars += event.text.length;
          break;
        }
        case "tool_call_complete": {
          result.toolCalls.push({
            name: event.toolName,
            args: event.arguments,
          });
          break;
        }
        case "stream_end": {
          result.completed = true;
          result.stopReason = event.stopReason;
          result.usage = event.usage;
          break;
        }
        default:
          break;
      }
    }
  } catch (err) {
    result.error = {
      name: err instanceof Error ? err.name : typeof err,
      message: err instanceof Error ? err.message : String(err),
      classified: err instanceof LLMError,
    };
  } finally {
    clearTimeout(timer);
    result.elapsedMs = Date.now() - started;
  }
  return result;
}

function excerpt(value: string, max: number): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}...` : flat;
}

function judge(
  expectation: Expectation,
  res: AttemptResult,
): { verdict: "PASS" | "FAIL"; detail: string } {
  if (expectation.outcome === "any") {
    // Nondeterministic endpoint: either outcome passes as long as it is
    // handled gracefully (classified error, or a completed non-empty stream).
    if (res.error) {
      if (!res.error.classified) {
        return {
          verdict: "FAIL",
          detail: `error escaped classification (not an LLMError): ${res.error.name}: ${excerpt(res.error.message, 160)}`,
        };
      }
      return {
        verdict: "PASS",
        detail: `tolerated error ${res.error.name}: ${excerpt(res.error.message, 120)}`,
      };
    }
    if (!res.completed || res.text.trim() === "") {
      return {
        verdict: "FAIL",
        detail: `tolerated-success branch requires a completed non-empty stream (completed=${res.completed})`,
      };
    }
    return {
      verdict: "PASS",
      detail: `tolerated success: ${describeSuccess(res)}`,
    };
  }
  if (expectation.outcome === "error") {
    if (!res.error) {
      const tools = res.toolCalls.map((tc) => tc.name).join(",");
      return {
        verdict: "FAIL",
        detail:
          `expected an error but the request succeeded ` +
          `(stop=${res.stopReason} tools=[${tools}] text=${excerpt(res.text, 60)})`,
      };
    }
    if (!res.error.classified) {
      return {
        verdict: "FAIL",
        detail: `error escaped classification (not an LLMError): ${res.error.name}: ${excerpt(res.error.message, 160)}`,
      };
    }
    if (expectation.errorName && res.error.name !== expectation.errorName) {
      return {
        verdict: "FAIL",
        detail: `expected ${expectation.errorName}, got ${res.error.name}: ${excerpt(res.error.message, 160)}`,
      };
    }
    return {
      verdict: "PASS",
      detail: `${res.error.name}: ${excerpt(res.error.message, 160)}`,
    };
  }

  if (res.error) {
    return {
      verdict: "FAIL",
      detail: `${res.error.name}: ${excerpt(res.error.message, 200)}`,
    };
  }
  if (!res.completed) {
    return {
      verdict: "FAIL",
      detail: "stream ended without stream_end event",
    };
  }
  if (expectation.expectToolCall) {
    const call = res.toolCalls.find(
      (tc) => tc.name === expectation.expectToolCall,
    );
    if (!call) {
      return {
        verdict: "FAIL",
        detail: `model never called ${expectation.expectToolCall} (text=${excerpt(res.text, 80)})`,
      };
    }
    return {
      verdict: "PASS",
      detail: `called ${call.name}(${excerpt(JSON.stringify(call.args), 60)}) stop=${res.stopReason}`,
    };
  }
  if (res.text.trim() === "") {
    return { verdict: "FAIL", detail: "completed but returned empty text" };
  }
  return { verdict: "PASS", detail: describeSuccess(res) };
}

function describeSuccess(res: AttemptResult): string {
  const usage = res.usage
    ? `in=${res.usage.inputTokens} out=${res.usage.outputTokens}`
    : "usage=n/a";
  return `stop=${res.stopReason} ${usage} deltas=${res.textDeltas} thinking=${res.thinkingChars}ch text="${excerpt(res.text, 80)}"`;
}

function formatExpectation(exp: Expectation): string {
  if (exp.outcome === "any") {
    return "any(ok|error)";
  }
  if (exp.outcome === "error") {
    return exp.errorName ? `error(${exp.errorName})` : "error";
  }
  return exp.expectToolCall ? `ok(tool:${exp.expectToolCall})` : "ok";
}

interface Row {
  provider: string;
  protocol: string;
  scenario: ScenarioName;
  expected: string;
  verdict: "PASS" | "FAIL";
  elapsedMs: number;
  detail: string;
  retried: boolean;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  let scenarios = ALL_SCENARIOS;
  const onlyIdx = argv.findIndex(
    (a) => a === "--only" || a.startsWith("--only="),
  );
  if (onlyIdx !== -1) {
    // Both spellings are accepted: `--only text,image` and `--only=text,image`.
    const flag = argv[onlyIdx];
    let raw: string;
    if (flag.startsWith("--only=")) {
      raw = flag.slice("--only=".length);
      argv.splice(onlyIdx, 1);
    } else {
      raw = argv[onlyIdx + 1] ?? "";
      argv.splice(onlyIdx, 2);
    }
    const picked = raw
      .split(",")
      .map((s) => s.trim())
      .filter((s): s is ScenarioName =>
        ALL_SCENARIOS.some((name) => name === s),
      );
    if (picked.length === 0) {
      console.error(
        `--only expects a comma-separated list of: ${ALL_SCENARIOS.join(",")}`,
      );
      process.exit(2);
    }
    scenarios = picked;
    argv.splice(onlyIdx, 2);
  }
  const providerFilter = argv.filter((a) => !a.startsWith("--"));

  const cfg = loadConfig();
  const known = cfg.providers.map((p) => p.name);
  const unknown = providerFilter.filter((n) => !known.includes(n));
  if (unknown.length > 0) {
    console.error(
      `Unknown provider(s): ${unknown.join(", ")}. Configured: ${known.join(", ")}`,
    );
    process.exit(2);
  }
  const providers =
    providerFilter.length > 0
      ? cfg.providers.filter((p) => providerFilter.includes(p.name))
      : cfg.providers;

  const pngBase64 = await makeRedPngBase64();
  const rows: Row[] = [];

  for (const provider of providers) {
    console.log(
      `\n=== ${provider.name} (protocol=${provider.protocol}, model=${provider.model}) ===`,
    );
    for (const scenario of scenarios) {
      const expectation =
        EXPECTATIONS[provider.name]?.[scenario] ??
        DEFAULT_EXPECTATIONS[scenario];
      process.stdout.write(
        `  [${scenario.padEnd(5)}] expect ${formatExpectation(expectation).padEnd(26)} `,
      );
      let res = await runScenario(provider, scenario, pngBase64);
      let retried = false;
      // One retry for transient network failures on endpoints expected healthy.
      if (res.error?.name === "NetworkError" && expectation.outcome === "ok") {
        retried = true;
        process.stdout.write("network error, retrying... ");
        res = await runScenario(provider, scenario, pngBase64);
      }
      const { verdict, detail } = judge(expectation, res);
      console.log(
        `${verdict} ${(res.elapsedMs / 1000).toFixed(1)}s${retried ? " (retried)" : ""}\n          ${detail}`,
      );
      rows.push({
        provider: provider.name,
        protocol: provider.protocol,
        scenario,
        expected: formatExpectation(expectation),
        verdict,
        elapsedMs: res.elapsedMs,
        detail,
        retried,
      });
    }
  }

  console.log("\n===== SMOKE SUMMARY =====");
  const w = { p: 16, s: 10, e: 28, v: 8, t: 8 };
  console.log(
    `${"PROVIDER".padEnd(w.p)}${"SCENARIO".padEnd(w.s)}${"EXPECTED".padEnd(w.e)}${"VERDICT".padEnd(w.v)}ELAPSED`,
  );
  for (const row of rows) {
    console.log(
      `${row.provider.padEnd(w.p)}${row.scenario.padEnd(w.s)}${row.expected.padEnd(w.e)}${row.verdict.padEnd(w.v)}${(row.elapsedMs / 1000).toFixed(1)}s${row.retried ? " (retried)" : ""}`,
    );
  }
  const passed = rows.filter((r) => r.verdict === "PASS").length;
  const failed = rows.length - passed;
  console.log(`\nPassed: ${passed}  Failed: ${failed}  Total: ${rows.length}`);
  if (failed > 0) {
    console.log("\nFailed details:");
    for (const row of rows.filter((r) => r.verdict === "FAIL")) {
      console.log(`  ${row.provider}/${row.scenario}: ${row.detail}`);
    }
  }
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err: unknown) => {
  console.error("Smoke runner crashed:", err);
  process.exit(2);
});

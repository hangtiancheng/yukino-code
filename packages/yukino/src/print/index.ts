import { prepareInvocationSession } from "@/bootstrap/headless.js";
import { loadInvocationInput } from "@/bootstrap/invocation.js";
import type { InvocationOptions } from "@/cli.js";
import { parse as parseCommand } from "@/commands/commands.js";
import { createCostLedger } from "@/cost/ledger.js";
import {
  createAgentSession,
  type AgentSession,
  type PromptInput,
  type PromptResult,
} from "@/sdk/index.js";
import type { SessionManager } from "@/session/manager.js";
import { asErrorString } from "@/utils/format.js";
import { ULTRACODE_PROMPT } from "@/workflow/prompts.js";

export type OutputFormat = "text" | "stream-json";
export interface PrintArgs {
  prompt: string;
  outputFormat: OutputFormat;
  options?: InvocationOptions;
}

function jsonLine(value: unknown): void {
  process.stdout.write(
    JSON.stringify(value, (_key, item: unknown) =>
      item instanceof Error
        ? {
            name: item.name,
            message: item.message,
            ...(item.cause !== undefined ? { cause: item.cause } : {}),
            ...(item instanceof AggregateError ? { errors: item.errors } : {}),
          }
        : item,
    ) + "\n",
  );
}

function errorMessage(error: unknown): string {
  if (error instanceof AggregateError) {
    return `${error.message}: ${error.errors.map(errorMessage).join("; ")}`;
  }
  return asErrorString(error);
}

export async function runPrintMode(args: PrintArgs): Promise<void> {
  const startedAt = Date.now();
  const options = args.options ?? {};
  const controller = new AbortController();
  let session: AgentSession | undefined;
  let manager: SessionManager | undefined;
  let result: PromptResult | undefined;
  let runError: Error | undefined;
  let thrown = false;
  const previousAttempts = new Set<string>();
  let interruptedCode: number | undefined;
  let approvalRequired = false;
  let backgroundTimedOut = false;
  let turns = 0;
  const tools: string[] = [];
  const cleanupErrors: unknown[] = [];
  let unsubscribe = (): void => undefined;
  let tasks: ReturnType<AgentSession["getTasks"]> = [];
  let workflows: ReturnType<AgentSession["getWorkflowState"]> = [];
  let teammates: Awaited<
    ReturnType<AgentSession["waitForBackground"]>
  >["teammates"] = [];
  const unavailable = (): Promise<never> => {
    approvalRequired = true;
    return Promise.reject(
      new Error(
        "Print mode requires explicit preauthorization or an interactive host",
      ),
    );
  };
  const interrupt = (code: number): void => {
    interruptedCode = code;
    process.exitCode = code;
    controller.abort();
  };
  const onInterrupt = (): void => {
    interrupt(130);
  };
  const onTerminate = (): void => {
    interrupt(143);
  };
  process.once("SIGINT", onInterrupt);
  process.once("SIGTERM", onTerminate);
  try {
    const invocation = await prepareInvocationSession(options);
    manager = invocation.sessionManager;
    ({ session } = await createAgentSession({
      ...invocation,
      inputSource: "print",
      signal: controller.signal,
      onPermissionRequest: unavailable,
      askUser: unavailable,
      planApproval: unavailable,
    }));
    for (const entry of session.getCostEntries()) {
      previousAttempts.add(entry.attemptId);
    }
    unsubscribe = session.subscribe((event) => {
      if (event.type === "turn_complete") {
        turns++;
      }
      if (event.type === "tool_use") {
        tools.push(event.payload.toolName);
      }
      if (event.type === "error") {
        runError ??= event.payload.error;
      }
      if (args.outputFormat === "stream-json") {
        jsonLine(event);
      } else if (event.type === "stream_text") {
        process.stdout.write(event.payload.text);
      }
    });
    let input = await loadInvocationInput(args.prompt, options, invocation.cwd);
    const command = parseCommand(
      typeof input === "string"
        ? input
        : typeof input[0]?.text === "string"
          ? input[0].text
          : "",
    );
    if (command?.name === "ultracode") {
      const text = `${ULTRACODE_PROMPT}\n\nTask: ${command.args}`;
      input =
        typeof input === "string"
          ? text
          : [{ type: "text", text }, ...input.slice(1)];
    }
    const normalized: string | PromptInput =
      typeof input === "string"
        ? input
        : {
            text: input
              .filter((block) => block.type === "text")
              .map((block) => String(block.text))
              .join("\n\n"),
            attachments: input.filter((block) => block.type !== "text"),
          };
    result = await session.prompt(normalized, { signal: controller.signal });
    if (
      !controller.signal.aborted &&
      result.status === "completed" &&
      !approvalRequired
    ) {
      const background = await session.waitForBackground({
        timeoutMs: 60_000,
        signal: controller.signal,
      });
      backgroundTimedOut = background.timedOut;
      teammates = background.teammates;
    }
  } catch (error) {
    if (
      !controller.signal.aborted ||
      (error !== controller.signal.reason &&
        !(error instanceof Error && error.name === "AbortError"))
    ) {
      thrown = true;
      runError ??= error instanceof Error ? error : new Error(String(error));
    }
  } finally {
    if (session) {
      try {
        if (
          controller.signal.aborted ||
          runError ||
          approvalRequired ||
          result?.status !== "completed"
        ) {
          await session.abort("background");
        }
        workflows = session.getWorkflowState();
      } catch (error) {
        cleanupErrors.push(error);
      }
      try {
        await session.dispose();
      } catch (error) {
        cleanupErrors.push(error);
      }
      try {
        tasks = session.getTasks();
        if (result) {
          result.messages = session.getMessages();
          const ledger = createCostLedger({
            sessionId: result.sessionId,
            persist: false,
          });
          ledger.replay(
            session
              .getCostEntries()
              .filter((entry) => !previousAttempts.has(entry.attemptId)),
          );
          result.cost = ledger.summary();
          if (result.cost.attempts) {
            result.usage = { ...result.usage, ...result.cost.usage };
          }
        }
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    unsubscribe();
    process.off("SIGINT", onInterrupt);
    process.off("SIGTERM", onTerminate);
  }
  const failedTask = tasks.find(
    (task) => task.kind !== "shell" && task.status === "failed",
  );
  if (failedTask) {
    runError ??= new Error(failedTask.error ?? failedTask.output);
  }
  const failedTeammate = teammates.find(
    (teammate) => teammate.status === "failed",
  );
  if (failedTeammate) {
    runError ??= new Error(failedTeammate.lastMessage ?? "Teammate failed");
  }
  if (backgroundTimedOut) {
    runError ??= new Error("Background work timed out");
  }
  const status =
    controller.signal.aborted || result?.status === "aborted"
      ? "aborted"
      : runError ||
          approvalRequired ||
          cleanupErrors.length ||
          result?.status !== "completed"
        ? "failed"
        : "completed";
  if (interruptedCode) {
    process.exitCode = interruptedCode;
  } else if (status !== "completed") {
    process.exitCode = status === "aborted" ? 130 : 1;
  }
  if (args.outputFormat === "stream-json") {
    jsonLine({
      type: "result",
      status,
      result: result?.text ?? "",
      stop_reason:
        status === "aborted" ? "interrupted" : (result?.stopReason ?? "error"),
      session_id: result?.sessionId ?? manager?.id ?? null,
      run_id: result?.runId ?? null,
      duration_ms: Date.now() - startedAt,
      num_turns: turns,
      tool_calls: tools,
      usage: result?.usage ?? null,
      cost: result?.cost ?? null,
      tasks,
      workflows,
      teammates,
      ...(runError ? { error: runError } : {}),
      ...(approvalRequired ? { approval_required: true } : {}),
      ...(backgroundTimedOut ? { background_timed_out: true } : {}),
      ...(cleanupErrors.length ? { cleanup_errors: cleanupErrors } : {}),
    });
  } else {
    process.stdout.write("\n");
    for (const task of tasks.filter((task) => task.kind !== "shell")) {
      process.stdout.write(`[${task.name}: ${task.status}]\n${task.output}\n`);
    }
    for (const teammate of teammates) {
      if (teammate.lastMessage) {
        process.stdout.write(
          `[${teammate.name}: ${teammate.status}]\n${teammate.lastMessage}\n`,
        );
      }
    }
    if (runError) {
      process.stderr.write(`Print failed: ${errorMessage(runError)}\n`);
    }
    if (approvalRequired) {
      process.stderr.write(
        "Print stopped: an interaction requires preauthorization or an interactive host.\n",
      );
    }
    for (const error of cleanupErrors) {
      process.stderr.write(`Print cleanup failed: ${errorMessage(error)}\n`);
    }
  }
  if (thrown) {
    throw runError ?? new Error("Print execution failed");
  }
  if (cleanupErrors.length) {
    throw runError ?? cleanupErrors[0];
  }
}

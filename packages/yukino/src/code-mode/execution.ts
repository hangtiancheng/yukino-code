import { randomBytes } from "node:crypto";

import {
  CODE_MODE_MAX_CALLS,
  CODE_MODE_MAX_OUTPUT_CHARS,
} from "@/code-mode/constants.js";
import {
  acquireCodeModeRun,
  appendCodeModeRecord,
  codeModeStore,
  readCodeModeRuns,
  type CodeModeEvent,
} from "@/code-mode/persistence.js";
import {
  CODE_MODE_FINGERPRINT,
  startCodeModeRun,
} from "@/code-mode/runtime.js";
import { VmJsonSchema } from "@/code-mode/schema.js";
import type {
  CodeModeCall,
  CodeModeHost,
  CodeModeOutcome,
  CodeModeRun,
  CodeModeSavedRun,
  CodeModeVmResult,
  CodeModeResult,
} from "@/code-mode/types.js";
import {
  declaredFileOperations,
  mergeFileOperations,
} from "@/session/file-operations.js";
import { writeSpill } from "@/tool-result/index.js";
import type { ToolResult, ToolResultContentBlock } from "@/tools/types.js";
import { asErrorString } from "@/utils/index.js";

const memoryRuns = new WeakMap<object, Map<string, CodeModeSavedRun>>();

export interface CodeModeInput {
  code: string;
  timeout_ms: number;
  max_output_tokens: number;
}

function equalJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export class CodeModeExecution {
  private vm?: CodeModeRun;
  private controller = new AbortController();
  private shutdown = false;

  async close(): Promise<void> {
    this.shutdown = true;
    await this.vm?.close();
    this.controller.abort(new Error("Code Mode host is shutting down."));
  }

  async execute(
    host: CodeModeHost,
    id: string,
    input: CodeModeInput,
    signal?: AbortSignal,
  ): Promise<CodeModeResult> {
    const release = acquireCodeModeRun(host.transcriptPath, id);
    try {
      return await this.run(host, id, input, signal);
    } finally {
      release();
    }
  }

  private async run(
    host: CodeModeHost,
    id: string,
    input: CodeModeInput,
    signal?: AbortSignal,
  ): Promise<CodeModeResult> {
    const runs = host.transcriptPath
      ? readCodeModeRuns(host.transcriptPath)
      : (memoryRuns.get(host.stateKey) ?? new Map<string, CodeModeSavedRun>());
    if (!host.transcriptPath) {
      memoryRuns.set(host.stateKey, runs);
    }
    let saved = runs.get(id);
    if (saved?.result) {
      return structuredClone(saved.result);
    }
    if (!saved) {
      const startedAt = Date.now();
      saved = {
        id,
        fingerprint: CODE_MODE_FINGERPRINT,
        start: {
          code: input.code,
          tools: host.tools(),
          store: codeModeStore(runs),
          seed: randomBytes(4).readUInt32LE(),
          startedAt,
          deadline: startedAt + input.timeout_ms,
          maxOutputTokens: input.max_output_tokens,
        },
        calls: [],
        started: [],
        journal: [],
      };
      appendCodeModeRecord(host.transcriptPath, {
        kind: "start",
        id,
        start: saved.start,
        fingerprint: saved.fingerprint,
      });
      runs.set(id, saved);
    }
    const state = saved;
    const write = (event: CodeModeEvent) => {
      appendCodeModeRecord(host.transcriptPath, event);
    };
    const finish = (
      result: CodeModeResult,
      store?: Record<string, unknown>,
    ): CodeModeResult => {
      if (this.shutdown) {
        return {
          output: "Code Mode suspended for host shutdown.",
          isError: true,
          suspended: true,
        };
      }
      const fileOperations = mergeFileOperations(
        ...state.journal.map((entry) =>
          entry.outcome.ok
            ? declaredFileOperations(entry.outcome.value.structuredContent)
            : entry.outcome.fileOperations,
        ),
      );
      if (
        fileOperations.readFiles.length ||
        fileOperations.modifiedFiles.length
      ) {
        result = {
          ...result,
          structuredContent: {
            ...result.structuredContent,
            fileOperations,
          },
        };
      }
      write({ kind: "finished", id, result, ...(store ? { store } : {}) });
      state.result = result;
      state.store = store;
      return result;
    };
    if (
      state.fingerprint !== CODE_MODE_FINGERPRINT ||
      state.start.code !== input.code
    ) {
      return finish({
        output:
          "Code Mode cannot resume: script or runtime fingerprint changed.",
        isError: true,
      });
    }
    const current = new Map(host.tools().map((tool) => [tool.name, tool]));
    if (
      state.start.tools.some((tool) => !equalJson(tool, current.get(tool.name)))
    ) {
      return finish({
        output: "Code Mode cannot resume: available tool declarations changed.",
        isError: true,
      });
    }
    const unknown = state.started.filter(
      (callId) => !state.journal.some((entry) => entry.id === callId),
    );
    if (unknown.length > 0) {
      return finish({
        output: `Code Mode cannot resume: calls ${unknown.join(", ")} started but their outcomes were not recorded. They will not be retried because side effects may have occurred.`,
        isError: true,
      });
    }
    if (Date.now() >= state.start.deadline) {
      return finish({
        output: "Code Mode deadline expired; no calls were resumed.",
        isError: true,
      });
    }
    const combined = signal
      ? AbortSignal.any([signal, this.controller.signal])
      : this.controller.signal;
    const oldCalls = [...state.calls];
    const oldJournal = [...state.journal];
    const oldFirstIssued = state.firstIssued;
    let recordedChars = oldJournal.reduce(
      (size, entry) => size + JSON.stringify(entry.outcome).length,
      0,
    );
    const seen: CodeModeCall[] = [];
    const pending = new Map<number, CodeModeCall>();
    let replaying = oldJournal.length > 0 || oldCalls.length > 0;
    let pumping = false;
    let settled = false;
    let failure: string | undefined;
    let highestSeq = 0;
    const fail = (error: unknown) => {
      failure ??= asErrorString(error);
      this.controller.abort(new Error(failure));
    };
    const checkpoint = (seq: number, issued: number) => {
      if (seq === 0) {
        if (state.firstIssued === undefined) {
          write({ kind: "idle", id, seq, issued });
          state.firstIssued = issued;
        } else if (state.firstIssued !== issued) {
          throw new Error(
            "Code Mode replay diverged at its initial checkpoint.",
          );
        }
      } else {
        const entry = state.journal[seq - 1];
        if (!entry) {
          throw new Error("Code Mode replay produced an unknown checkpoint.");
        }
        if (entry.issued >= 0 && entry.issued !== issued) {
          throw new Error("Code Mode replay changed its issued-call count.");
        }
        if (entry.issued < 0) {
          write({ kind: "idle", id, seq, issued });
          entry.issued = issued;
        }
      }
    };
    const saveCalls = () => {
      const fresh = seen.slice(state.calls.length);
      if (fresh.length > 0) {
        write({ kind: "calls", id, calls: fresh });
        state.calls.push(...fresh);
      }
    };
    const pump = async () => {
      if (pumping || settled || replaying || combined.aborted) {
        return;
      }
      pumping = true;
      try {
        while (pending.size > 0 && !settled && !combined.aborted) {
          const batch = [...pending.values()];
          pending.clear();
          saveCalls();
          const byId = new Map(
            batch.map((call) => [`${id}/c${call.id}`, call]),
          );
          const calls = batch.map((call) => ({
            toolUseId: `${id}/c${call.id}`,
            toolName: call.name,
            arguments: call.args,
          }));
          for await (const result of host.execute(calls, combined, (toolId) => {
            const call = byId.get(toolId);
            if (!call) {
              throw new Error("Unknown nested Code Mode call.");
            }
            write({ kind: "started", id, callId: call.id });
            state.started.push(call.id);
            host.progress?.(`${call.name} started`);
          })) {
            if (settled || combined.aborted) {
              break;
            }
            const call = byId.get(result.toolId);
            if (!call) {
              throw new Error("Unknown nested Code Mode result.");
            }
            const { toolId: _toolId, ...value } = result;
            let outcome: CodeModeOutcome = { ok: true, value };
            if (
              recordedChars + JSON.stringify(outcome).length >
              CODE_MODE_MAX_OUTPUT_CHARS
            ) {
              const fileOperations = declaredFileOperations(
                value.structuredContent,
              );
              outcome = {
                ok: false,
                error: `${call.name} output exceeds the Code Mode tool bridge limit.`,
                ...(fileOperations ? { fileOperations } : {}),
              };
            }
            recordedChars += JSON.stringify(outcome).length;
            const now = Date.now();
            write({ kind: "result", id, callId: call.id, now, outcome });
            state.journal.push({ id: call.id, now, outcome, issued: -1 });
            host.progress?.(
              `${call.name} ${result.isError ? "failed" : "completed"}`,
            );
            this.vm?.deliver(state.journal.length, now, call.id, outcome);
          }
        }
      } catch (error) {
        fail(error);
      } finally {
        pumping = false;
      }
    };
    this.vm = startCodeModeRun(state.start, {
      signal: combined,
      onCall: (call) => {
        try {
          if (settled) {
            return;
          }
          if (
            call.id !== seen.length + 1 ||
            seen.length >= CODE_MODE_MAX_CALLS
          ) {
            throw new Error("Invalid Code Mode call sequence.");
          }
          const old = oldCalls[call.id - 1];
          if (old && !equalJson(old, call)) {
            throw new Error(
              "Code Mode replay changed a tool call or its arguments.",
            );
          }
          seen.push(call);
          pending.set(call.id, call);
        } catch (error) {
          fail(error);
        }
      },
      onIdle: (seq, issued) => {
        try {
          if (settled || combined.aborted) {
            return;
          }
          if (seq < highestSeq || issued !== seen.length) {
            throw new Error("Invalid Code Mode replay checkpoint.");
          }
          highestSeq = seq;
          if (replaying) {
            const expected =
              seq === 0 ? oldFirstIssued : oldJournal[seq - 1]?.issued;
            if (
              expected !== undefined &&
              expected >= 0 &&
              expected !== issued
            ) {
              throw new Error("Code Mode replay diverged at a checkpoint.");
            }
            checkpoint(seq, issued);
            const next = oldJournal[seq];
            if (next) {
              if (!pending.delete(next.id)) {
                throw new Error(
                  "Code Mode replay did not issue its recorded call.",
                );
              }
              this.vm?.deliver(seq + 1, next.now, next.id, next.outcome);
              return;
            }
            if (seen.length < oldCalls.length) {
              throw new Error(
                "Code Mode replay ended before its recorded calls.",
              );
            }
            replaying = false;
          } else {
            saveCalls();
            checkpoint(seq, issued);
          }
          saveCalls();
          void pump();
        } catch (error) {
          fail(error);
        }
      },
    });
    let vmResult: CodeModeVmResult;
    try {
      vmResult = await this.vm.result;
      settled = true;
      if (vmResult.shutdown || this.shutdown) {
        this.shutdown = true;
        return {
          output: "Code Mode suspended for host shutdown.",
          isError: true,
          suspended: true,
        };
      }
      if (
        replaying &&
        (vmResult.during.seq < oldJournal.length ||
          seen.length < oldCalls.length)
      ) {
        failure ??=
          "Code Mode replay ended before its historical prefix was verified.";
      }
      if (!failure) {
        saveCalls();
        checkpoint(vmResult.during.seq, vmResult.during.issued);
      }
      if (failure) {
        vmResult = { ...vmResult, ok: false, error: failure };
      }
      const blocks: ToolResultContentBlock[] = [...vmResult.output];
      if (vmResult.ok && vmResult.value !== undefined) {
        blocks.push({
          type: "text",
          text:
            typeof vmResult.value === "string"
              ? vmResult.value
              : JSON.stringify(vmResult.value),
        });
      }
      if (!vmResult.ok) {
        blocks.push({
          type: "text",
          text: `Script error: ${vmResult.error ?? "Execution failed"}`,
        });
      }
      let output = blocks
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n");
      let artifact:
        | { id: string; path: string; mimeType: string; size: number }
        | undefined;
      const budget = state.start.maxOutputTokens * 4;
      let inlineBlocks = blocks;
      let structuredContent =
        vmResult.value !== undefined ? { value: vmResult.value } : undefined;
      const payload = {
        output,
        contentBlocks: blocks,
        ...(structuredContent ? { structuredContent } : {}),
      };
      const full = JSON.stringify(payload);
      if (full.length > budget || !VmJsonSchema.safeParse(payload).success) {
        const head = output.slice(0, Math.floor(budget / 2));
        const tail = output.slice(-Math.ceil(budget / 2));
        try {
          const path = writeSpill(host.sessionId, id, full);
          artifact = {
            id,
            path,
            mimeType: "application/json",
            size: Buffer.byteLength(full),
          };
          output = `${head}\n… output truncated …\n${tail}\nFull output: ${path}`;
        } catch (error) {
          output = `${head}\n… output truncated …\n${tail}\nCould not save full output: ${asErrorString(error)}`;
        }
        inlineBlocks = [{ type: "text", text: output }];
        structuredContent = undefined;
      }
      const result: ToolResult & { artifact?: typeof artifact } = {
        output: `${vmResult.ok ? "Script completed" : "Script failed"}\n${output}`,
        contentBlocks: inlineBlocks,
        rawContent: structuredClone(inlineBlocks),
        ...(structuredContent ? { structuredContent } : {}),
        ...(artifact ? { artifact } : {}),
        isError: !vmResult.ok,
      };
      return finish(result, vmResult.ok ? vmResult.store : undefined);
    } finally {
      settled = true;
      this.controller.abort(new Error("Code Mode execution ended."));
      await this.vm.close();
    }
  }
}

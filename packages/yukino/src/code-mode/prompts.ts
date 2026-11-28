import { CODE_MODE_INLINE_CHARS } from "@/code-mode/constants.js";
import type { CodeModeDeclaration } from "@/code-mode/types.js";

export const CODE_MODE_DESCRIPTION = `Run JavaScript in an isolated QuickJS WASM sandbox to compose tools, await parallel reads, filter large results, and return only relevant output. Input code is an async function body, not a markdown fence. Top-level await and return work. No Node.js, filesystem, network, timers, or imports are available except through tools.
Call tools.<exactName>(args); calls resolve to {output, isError, structuredContent?, contentBlocks?, rawContent?, artifact?}. Inspect isError for tool failures; transport failures reject with Error. Use Promise.allSettled to keep successful calls when another fails. Tools still obey the agent's permissions, hooks, and concurrency rules. Changes made by tools are real and are not rolled back on script failure.
ALL_TOOLS lists callable tools with name, description, namespace and source; namespaces.<namespace>[exactName](args) groups calls. searchTools(query, {limit?, namespace?, source?}) finds tools; describeTool(name) returns their full input schema, namespace and source. text(value), console.log(value), and return emit selected output. image(block) emits an existing base64 image block. store(key, value) and load(key) preserve small JSON values only after a successful script; store(key, undefined) deletes a key.
CodeMode, Agent, Workflow, TaskOutput, LoadSkill and plan/worktree transitions cannot be called from scripts; use those tools directly. Execution has a hard deadline and memory/output limits. On restart, recorded results can be replayed, but started calls whose results were not recorded will never be retried automatically.`;
export const CODE_MODE_CODE_DESCRIPTION =
  "JavaScript async function body. Use tools, await, text, image, and return; no imports or markdown fences.";
export const CODE_MODE_TIMEOUT_DESCRIPTION =
  "Overall execution deadline in milliseconds, including tool calls and worker waiting; it does not reset on recovery.";
export const CODE_MODE_OUTPUT_DESCRIPTION =
  "Approximate token budget for selected script output; larger text is saved to a file.";

export function describeCodeModeTools(
  tools: CodeModeDeclaration[],
  budget = CODE_MODE_INLINE_CHARS,
): string {
  const lines: string[] = [];
  let size = 0;
  for (const tool of tools) {
    const line = `${tool.name}: ${tool.description}\nInput: ${JSON.stringify(tool.schema.input_schema)}`;
    const cost = line.length + (lines.length ? 2 : 0);
    if (size + cost > budget) {
      continue;
    }
    lines.push(line);
    size += cost;
  }
  return `Code Mode callable tools (use describeTool for full schemas or searchTools for additional tools):\n${lines.join("\n\n")}`;
}

import { readFile, readdir, realpath } from "node:fs/promises";
import { parse, resolve } from "node:path";

import { asRecord } from "@/utils/index.js";
import { WORKFLOW_SCRIPT_EXTENSIONS } from "@/workflow/constants.js";
import { containsPath, sanitizeWorkflowName } from "@/workflow/paths.js";

function isScriptExt(ext: string): boolean {
  return WORKFLOW_SCRIPT_EXTENSIONS.some(
    (supported) => supported === ext.toLowerCase(),
  );
}

export async function resolveNamedWorkflow(
  workflowDir: string,
  name: string,
): Promise<{ path: string; content: string } | null> {
  if (sanitizeWorkflowName(name) === null) {
    return null;
  }
  for (const ext of WORKFLOW_SCRIPT_EXTENSIONS) {
    const p = resolve(workflowDir, name + ext);

    if (!containsPath(workflowDir, p)) {
      return null;
    }
    try {
      const actual = await realpath(p);
      if (!containsPath(await realpath(workflowDir), actual)) {
        throw new Error("Workflow file is outside its workflow directory");
      }
      return { path: actual, content: await readFile(actual, "utf-8") };
    } catch (error) {
      if (asRecord(error).code !== "ENOENT") {
        throw error;
      }
    }
  }
  return null;
}

export async function listNamedWorkflows(
  workflowDir: string,
): Promise<string[]> {
  let files: string[];
  try {
    files = await readdir(workflowDir);
  } catch {
    return [];
  }
  return [
    ...new Set(
      files.filter((f) => isScriptExt(parse(f).ext)).map((f) => parse(f).name),
    ),
  ].sort();
}

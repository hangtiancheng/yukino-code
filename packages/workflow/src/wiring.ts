import type { ToolRegistry } from "@yukino.js/tools/registry.js";
import { WORKFLOW_TOOL_NAME } from "./constants.js";
import { WorkflowService, type WorkflowServiceOptions } from "./service.js";
import { WorkflowTool } from "./workflow-tool.js";

export function attachWorkflow(
  options: WorkflowServiceOptions,
): WorkflowService {
  const existing = getWorkflowService(options.registry);
  if (existing) {
    return existing;
  }
  const service = new WorkflowService(options);
  options.registry.register(new WorkflowTool(service));
  return service;
}

export function getWorkflowService(
  registry: ToolRegistry,
): WorkflowService | undefined {
  return registry.getInstanceOf(WORKFLOW_TOOL_NAME, WorkflowTool)?.service;
}

import type { WorkflowPorts } from "@/workflow/ports.js";
import type { ProgressEvent } from "@/workflow/types.js";
type ProgressEmitter = WorkflowPorts["progressEmitter"];

export type { ProgressEvent };

export function createProgressEmitter(
  onEvent: (e: ProgressEvent) => void,
): ProgressEmitter {
  return { emit: onEvent };
}

export function createBufferingEmitter(): {
  emitter: ProgressEmitter;
  events: ProgressEvent[];
} {
  const events: ProgressEvent[] = [];
  return { emitter: { emit: (e) => void events.push(e) }, events };
}

import { REMINDER_INTERVAL } from "./constants.js";
import { coordinatorPrompt, coordinatorSparseReminder } from "./prompts.js";

/** Periodic conversation reminders preserve guidance without changing the cached system prefix. */
export function coordinatorReminder(iteration = 1): string {
  if (iteration <= 1 || (iteration - 1) % REMINDER_INTERVAL === 0) {
    return coordinatorPrompt;
  }
  return coordinatorSparseReminder;
}

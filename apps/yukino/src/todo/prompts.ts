export const TODO_WRITE_DESCRIPTION =
  "Read or atomically edit the current TODO board. Call with {} to refresh the complete board. todos contains incremental edits: omit id to create (subject required, status defaults to pending), or supply an existing id to update only specified fields. Omitted tasks and fields are retained; empty arrays do nothing. deleteIds explicitly removes tasks and their links. Both creation and updates accept priority, owner, metadata and dependencies. blocks/blockedBy replace the specified dependency list and maintain reciprocal links; IDs must exist before this call. Self-dependencies, cycles and starting blocked work are rejected. Metadata merges top-level keys; null removes a key. Teammates claim in_progress tasks under their own name. Returns boardId, todos with IDs and TODO completed/total progress. Track complex work; this tool never launches an Agent or a background task.";

export const TODO_FIELD_DESCRIPTIONS = {
  id: "Existing task ID: a positive decimal integer string. Omit to create a task.",
  subject: "Brief task title; required when creating a task.",
  description:
    "What needs to be done; defaults to an empty string for new tasks.",
  status:
    "Task status; defaults to pending for new tasks. Use deleteIds to remove tasks.",
  owner:
    "Task owner. Only the leader may assign other teammates; an empty string unassigns.",
  priority: "Task priority, available during both creation and updates.",
  metadata:
    "Merge top-level context keys; null removes a key. Omitted keys are retained; nested values are replaced.",
  blocks:
    "Replace the list of existing task IDs this task blocks; [] removes these links.",
  blockedBy:
    "Replace the list of existing task IDs blocking this task; [] removes these links.",
  deleteIds:
    "Existing task IDs to delete atomically, removing their dependency links.",
};

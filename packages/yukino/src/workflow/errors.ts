export class WorkflowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowError";
  }
}

export class WorkflowAbortedError extends Error {
  constructor() {
    super("workflow has been aborted");
    this.name = "WorkflowAbortedError";
  }
}

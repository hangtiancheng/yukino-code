import { SDK_BUSY_ERROR, SDK_DISPOSED_ERROR } from "@/sdk/constants.js";

export class SessionBusyError extends Error {
  constructor() {
    super(SDK_BUSY_ERROR);
    this.name = "SessionBusyError";
  }
}
export class SessionDisposedError extends Error {
  constructor() {
    super(SDK_DISPOSED_ERROR);
    this.name = "SessionDisposedError";
  }
}

import { homedir } from "node:os";

import { REDACTED_PLACEHOLDER, SENSITIVE_KEY_PATTERN } from "./constants.js";
import { isRecord } from "@yukino.js/utils";
import {
  redactCredentials,
  environmentSecrets,
} from "@yukino.js/utils/redact.js";

export function scrubTelemetryPayload(value: unknown): void {
  const secrets = environmentSecrets();
  const redact = (text: string) => {
    text = redactCredentials(text, secrets, REDACTED_PLACEHOLDER);
    const home = homedir();
    if (home && home !== "/") {
      text = text
        .replaceAll(home, "~")
        .replaceAll(encodeURIComponent(home), "~");
    }
    return text;
  };
  const seen = new WeakSet<object>();
  const visit = (item: unknown): void => {
    if (typeof item !== "object" || item === null || seen.has(item)) {
      return;
    }
    seen.add(item);
    if (Array.isArray(item)) {
      for (let i = 0; i < item.length; i++) {
        const entry: unknown = item[i];
        if (typeof entry === "string") {
          item[i] = redact(entry);
        } else {
          visit(entry);
        }
      }
    } else if (isRecord(item)) {
      for (const [key, entry] of Object.entries(item)) {
        if (SENSITIVE_KEY_PATTERN.test(key)) {
          item[key] = REDACTED_PLACEHOLDER;
        } else if (typeof entry === "string") {
          item[key] = redact(entry);
        } else {
          visit(entry);
        }
      }
    }
  };
  visit(value);
}

import { homedir } from "node:os";

import { isRecord } from "@/utils/index.js";

export function scrubTelemetryPayload(value: unknown): void {
  const secrets = Object.entries(process.env).flatMap(([key, secret]) =>
    /(?:API_KEY|TOKEN|SECRET|PASSWORD|PRIVATE_KEY|DSN)/iu.test(key) &&
    secret &&
    secret.length >= 4
      ? [secret, encodeURIComponent(secret)]
      : [],
  );
  const redact = (text: string) => {
    for (const secret of secrets) {
      text = text.replaceAll(secret, "[redacted]");
    }
    const home = homedir();
    if (home && home !== "/") {
      text = text
        .replaceAll(home, "~")
        .replaceAll(encodeURIComponent(home), "~");
    }
    return text.replace(/\b(Bearer\s+)[\w.+/~=-]+/giu, "$1[redacted]");
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
        if (
          /(?:authorization|api[_-]?key|password|secret|credential|(?:^|[_-])token(?:$|[_-])|access[_-]?token|refresh[_-]?token|private[_-]?key|(?:^|[_-])dsn(?:$|[_-])|^(?:cookie|set-cookie)$)/iu.test(
            key,
          )
        ) {
          item[key] = "[redacted]";
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

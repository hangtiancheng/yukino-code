import { randomBytes } from "node:crypto";

export function generateSlug(): string {
  const timestamp = Date.now().toString(36);
  const entropy = randomBytes(6).toString("hex");
  return `${timestamp}-${entropy}`;
}

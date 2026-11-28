import { createHash } from "node:crypto";

import { CACHE_IDENTITY_FIELDS } from "@/cache/constants.js";
import { stableStringify } from "@/utils/json.js";

export interface CacheIdentityInput {
  provider: string;
  endpoint: string;
  model: string;
  system: string;
  tools: unknown;
  project: string;
  branch: string;
}

export function createCacheIdentity(input: CacheIdentityInput): string {
  return createHash("sha256")
    .update(stableStringify(input) ?? "")
    .digest("hex");
}

export class CacheIdentityTracker {
  private input?: CacheIdentityInput;
  private identity?: string;
  update(input: CacheIdentityInput): {
    identity: string;
    invalidationReasons: string[];
  } {
    const invalidationReasons = this.input
      ? CACHE_IDENTITY_FIELDS.filter(
          (key) =>
            stableStringify(this.input?.[key]) !== stableStringify(input[key]),
        )
      : ["initial"];
    this.input = structuredClone(input);
    this.identity = createCacheIdentity(input);
    return { identity: this.identity, invalidationReasons };
  }
  invalidate(reason: string): {
    identity?: string;
    invalidationReasons: string[];
  } {
    const identity = this.identity;
    this.input = undefined;
    this.identity = undefined;
    return { identity, invalidationReasons: [reason] };
  }
}

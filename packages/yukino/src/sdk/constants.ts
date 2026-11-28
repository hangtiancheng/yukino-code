import type { ProviderConfig } from "@/config/provider-config.js";
import type { UsageInfo } from "@/llm/events.js";

export const SDK_BUSY_ERROR =
  "Session is busy; select steer or followUp delivery explicitly";
export const SDK_DISPOSED_ERROR = "Session is disposed";
export const SDK_CLIENT_REQUIRED_ERROR = "Supply a client or provider";
export const SDK_EMPTY_PROMPT_ERROR = "Prompt must contain text or attachments";
export const SDK_MODEL_TARGET_ERROR =
  "Model changes require a configured provider target or a replacement client";
export const SDK_NO_APPROVAL_ERROR = "No approval callback; request denied";
export const SDK_MAX_QUEUE_ENTRIES = 128;
export const SDK_MAX_QUEUE_BYTES = 8 * 1024 * 1024;
export const CUSTOM_PROVIDER: ProviderConfig = {
  name: "custom",
  protocol: "anthropic",
  base_url: "",
  model: "custom",
};
export const EMPTY_USAGE: UsageInfo = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0,
};

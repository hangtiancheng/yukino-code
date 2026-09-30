import { createClient, type LLMClient } from "./client.js";

import type { ProviderConfig } from "@/config/provider-config.js";

export function createModelResolver(
  baseConfig: ProviderConfig,
  systemPrompt: string,
): (modelName: string) => Promise<LLMClient> {
  return (_modelName) => {
    return createClient(
      {
        ...baseConfig,
        model: _modelName,
      },
      systemPrompt,
    );
  };
}

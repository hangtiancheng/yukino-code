import { createClient, type LLMClient } from "./client.js";

import type { ProviderConfig } from "@/config/provider-config.js";

// Returns a function that builds a client for a given model name,
// reusing the base provider config (api key, base url, protocol) but swapping the model.
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

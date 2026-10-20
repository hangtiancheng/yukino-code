import type { ProviderConfig } from "@/config/provider-config.js";
import { createClient, type LLMClient } from "@/llm/client.js";


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

/**
 * Copyright (c) 2026 hangtiancheng
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

import { createClient, type LLMClient } from "./client.js";

import type { ProviderConfig } from "@/config/index.js";

// Short aliases the model field of an agent definition may use. Unknown names
// pass through unchanged so a full model id still works.
const MODEL_ALIASES: Record<string, string> = {
  haiku: "claude-haiku-4-6",
  sonnet: "claude-sonnet-4-6",
  opus: "claude-opus-4-6",
};

export function resolveModelId(shortName: string): string {
  return MODEL_ALIASES[shortName] ?? shortName;
}

// Returns a function that builds a client for a given short model name,
// reusing the base provider config (api key, base url, protocol) but swapping the model.
export function createModelResolver(
  baseConfig: ProviderConfig,
  systemPrompt: string,
): (shortName: string) => Promise<LLMClient> {
  return (shortName) => {
    return createClient(
      {
        ...baseConfig,
        model: resolveModelId(shortName),
      },
      systemPrompt,
    );
  };
}

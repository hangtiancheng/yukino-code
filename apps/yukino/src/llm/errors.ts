export class LLMError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LLMError";
  }
}

export class AuthenticationError extends LLMError {
  constructor(message: string) {
    super(message);
    this.name = "AuthenticationError";
  }
}

export class RateLimitError extends LLMError {
  retryAfter?: string | undefined;
  constructor(message: string, retryAfter?: string) {
    super(message);
    this.name = "RateLimitError";
    this.retryAfter = retryAfter;
  }
}

export class NetworkError extends LLMError {
  constructor(message: string) {
    super(message);
    this.name = "NetworkError";
  }
}

export class ContextTooLongError extends LLMError {
  constructor(message: string) {
    super(message);
    this.name = "ContextTooLongError";
  }
}

/**
 * Detects provider "context too long" failures across protocols by message.
 * Anthropic returns 400 invalid_request_error with "prompt is too long:
 * N tokens > M maximum"; OpenAI (and OpenAI-compatible gateways such as
 * DeepSeek) use the context_length_exceeded code or "maximum context length
 * is N tokens" wording.
 */
export function containsContextLengthError(msg: string): boolean {
  return (
    /context_length_exceeded/i.test(msg) ||
    /maximum\s+context\s+length/i.test(msg) ||
    /prompts?\s+(?:is\s+)?too\s+long/i.test(msg)
  );
}

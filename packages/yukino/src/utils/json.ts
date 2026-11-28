import { configure } from "safe-stable-stringify";

const stringify = configure({ strict: true });

export function stableStringify(value: unknown): string | undefined {
  return stringify(value);
}

export function extractJsonOutput(text: string): unknown {
  try {
    const value: unknown = JSON.parse(text);
    return value;
  } catch {
    /* Look for JSON in the final response. */
  }
  const candidates: string[] = [];
  for (const match of text.matchAll(/```[\w-]*\s*\n([\s\S]*?)\n?```/gu)) {
    candidates.push(match[1]);
  }
  for (let start = 0; start < text.length; start++) {
    if (text[start] !== "{" && text[start] !== "[") {
      continue;
    }
    const stack: string[] = [];
    let quoted = false;
    for (let end = start; end < text.length; end++) {
      const char = text[end];
      if (quoted) {
        if (char === "\\") {
          end++;
        } else if (char === '"') {
          quoted = false;
        }
        continue;
      }
      if (char === '"') {
        quoted = true;
      } else if (char === "{" || char === "[") {
        stack.push(char);
      } else if (char === "}" || char === "]") {
        if (stack.pop() !== (char === "}" ? "{" : "[")) {
          break;
        }
        if (stack.length === 0) {
          candidates.push(text.slice(start, end + 1));
          start = end;
          break;
        }
      }
    }
  }
  for (const candidate of candidates.reverse()) {
    try {
      const value: unknown = JSON.parse(candidate);
      return value;
    } catch {
      continue;
    }
  }
  throw new Error("No valid JSON output");
}

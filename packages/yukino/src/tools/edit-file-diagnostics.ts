function position(text: string, offset: number): string {
  const prefix = text.slice(0, offset);
  const line = (prefix.match(/\n/gu)?.length ?? 0) + 1;
  const column =
    Array.from(prefix.slice(prefix.lastIndexOf("\n") + 1)).length + 1;
  return `line ${String(line)}, column ${String(column)}`;
}

function character(text: string, offset: number): string {
  const codePoint = text.codePointAt(offset);
  if (codePoint === undefined) {
    return "end of text";
  }
  const value = JSON.stringify(String.fromCodePoint(codePoint)).replace(
    / /gu,
    "\\u0020",
  );
  return `${value} (U+${codePoint.toString(16).toUpperCase().padStart(4, "0")})`;
}

function context(text: string, offset: number): string {
  return JSON.stringify(
    text.slice(Math.max(0, offset - 30), offset + 30),
  ).replace(/ /gu, "\\u0020");
}

function mismatch(
  file: string,
  snippet: string,
  start: number,
  length: number,
): string {
  return [
    `First difference: old_string ${position(snippet, length)} has ${character(snippet, length)}; file ${position(file, start + length)} has ${character(file, start + length)}.`,
    `old_string context: ${context(snippet, length)}`,
    `file context: ${context(file, start + length)}`,
  ].join("\n");
}

function commonPrefix(file: string, snippet: string, start: number): number {
  let length = 0;
  while (
    length < snippet.length &&
    file.codePointAt(start + length) === snippet.codePointAt(length)
  ) {
    length += (snippet.codePointAt(length) ?? 0) > 0xffff ? 2 : 1;
  }
  return length;
}

function sourceOffset(text: string, normalizedOffset: number): number {
  let removed = 0;
  for (const whitespace of text.matchAll(/[^\S\r\n]+/gu)) {
    if (whitespace.index - removed >= normalizedOffset) {
      break;
    }
    removed += whitespace[0].length - 1;
  }
  return normalizedOffset + removed;
}

export function describeEditMismatch(
  content: string,
  oldString: string,
): string {
  const file = content.replace(/\r\n/gu, "\n");
  const snippet = oldString.replace(/\r\n/gu, "\n");
  const normalizedFile = file.replace(/[^\S\r\n]+/gu, " ");
  const normalizedSnippet = snippet.replace(/[^\S\r\n]+/gu, " ");
  const candidates: number[] = [];
  if (normalizedSnippet) {
    let cursor = 0;
    while (candidates.length < 3) {
      const index = normalizedFile.indexOf(normalizedSnippet, cursor);
      if (index < 0) {
        break;
      }
      candidates.push(sourceOffset(file, index));
      cursor = index + normalizedSnippet.length;
    }
  }

  const details: string[] = [];
  if (candidates.length > 0) {
    details.push(
      `Candidates matching after horizontal whitespace normalization (up to 3): ${candidates.map((start) => `file ${position(file, start)}`).join("; ")}. These are suggestions only; whitespace must match exactly.`,
    );
    const start = candidates[0];
    details.push(
      mismatch(file, snippet, start, commonPrefix(file, snippet, start)),
    );
  } else {
    // Prefix existence is monotonic, so binary search avoids rescanning for every character.
    let low = 0;
    let high = snippet.length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (file.includes(snippet.slice(0, middle))) {
        low = middle;
      } else {
        high = middle - 1;
      }
    }
    if (low > 0) {
      const start = file.indexOf(snippet.slice(0, low));
      details.push(
        `Longest matching prefix starts at file ${position(file, start)}.`,
      );
      details.push(
        mismatch(file, snippet, start, commonPrefix(file, snippet, start)),
      );
    } else {
      details.push(
        "No matching prefix or horizontal-whitespace candidate found.",
      );
    }
  }
  details.push("No edits were written.");
  return details.join("\n");
}

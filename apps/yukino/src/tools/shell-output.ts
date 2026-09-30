export const MAX_SHELL_OUTPUT_BYTES = 10 * 1024 * 1024;

export function utf8ByteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

/** Return a UTF-8-safe prefix whose encoded size does not exceed maxBytes. */
export function takeUtf8Prefix(value: string, maxBytes: number): string {
  if (maxBytes <= 0) {
    return "";
  }
  if (utf8ByteLength(value) <= maxBytes) {
    return value;
  }
  let used = 0;
  const parts: string[] = [];
  for (const character of value) {
    const bytes = utf8ByteLength(character);
    if (used + bytes > maxBytes) {
      break;
    }
    parts.push(character);
    used += bytes;
  }
  return parts.join("");
}

export function formatShellOutput(
  prompt: string,
  command: string,
  stdout: string,
  stderr: string,
  truncated: boolean,
): string {
  let output = `${prompt}${command}\n`;
  if (stdout) {
    output += stdout;
  }
  if (stderr) {
    output += stderr;
  }
  if (truncated) {
    output += "\n\n[Output truncated after 10 MB]";
  }
  return output;
}

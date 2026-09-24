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

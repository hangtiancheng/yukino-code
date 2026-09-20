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

export function parseRemoteAddress(address: string): {
  host: string;
  port: number;
} {
  const value = address.trim();
  const match = /^(?:\[([^\]]+)\]|([^:]*))(?::(\d+))?$/.exec(value);
  if (!match) {
    throw new Error("Invalid remote address; use host:port or [IPv6]:port");
  }
  const host = match[1] || match[2] || "127.0.0.1";
  const port = Number(match[3] ?? "18888");
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("Remote port must be an integer between 1 and 65535");
  }
  return { host, port };
}

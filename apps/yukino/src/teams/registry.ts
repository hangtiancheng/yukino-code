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

/**
 * In-process global name registry maintaining a member-name -> agentId mapping.
 * SendMessage uses it to resolve recipient names provided by the user/LLM into delivery identifiers.
 */
export class NameRegistry {
  private names = new Map<string, string>();

  /** Registers a name -> agentId mapping. */
  register(name: string, agentId: string): void {
    this.names.set(name, agentId);
  }

  /**
   * Resolves a name or ID to an agentId: looks up by name first; if the input is already an ID, returns it as-is;
   * returns undefined if neither lookup succeeds.
   */
  resolve(nameOrId: string): string | undefined {
    const byName = this.names.get(nameOrId);
    if (byName !== undefined) {
      return byName;
    }
    for (const id of this.names.values()) {
      if (id === nameOrId) {
        return nameOrId;
      }
    }
    return undefined;
  }

  /** Removes a name mapping. */
  unregister(name: string): void {
    this.names.delete(name);
  }

  /** Clears all mappings; primarily used for test isolation. */
  clear(): void {
    this.names.clear();
  }
}

let instance: NameRegistry | undefined;

/** Returns the global singleton registry. */
export function getNameRegistry(): NameRegistry {
  instance ??= new NameRegistry();
  return instance;
}

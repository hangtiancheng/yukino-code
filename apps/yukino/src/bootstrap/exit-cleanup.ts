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

// Best-effort synchronous cleanup registry for crash paths.
//
// process.exit() (terminal gone, uncaught exception, unhandled rejection)
// never awaits the async teardown paths (TaskManager.stopAll, MCP
// disconnectAll), so detached children would survive as orphans. The crash
// handlers in recover.ts sweep these callbacks instead. Handlers must be
// synchronous; failures are swallowed by design.

type Cleanup = () => void;

const cleanups = new Set<Cleanup>();

/** Registers a cleanup; the returned function unregisters it (call when the resource dies on its own). */
export function registerExitCleanup(fn: Cleanup): () => void {
  cleanups.add(fn);
  return () => {
    cleanups.delete(fn);
  };
}

/** Runs every registered cleanup once. Safe to call repeatedly. */
export function runExitCleanups(): void {
  for (const fn of [...cleanups]) {
    try {
      fn();
    } catch {
      // best-effort by design
    }
  }
}

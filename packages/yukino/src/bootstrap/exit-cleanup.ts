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
    if (!cleanups.delete(fn)) {
      continue;
    }
    try {
      fn();
    } catch {
      // best-effort by design
    }
  }
}

/**
 * Suppress Node's ExperimentalWarning for `node:sqlite`.
 *
 * The module is loaded lazily on first import, but ESM evaluates imports in
 * declaration order — so this must be the *first* import of the entrypoint to
 * run before anything pulls in `node:sqlite`. Without it every single CLI
 * invocation prints:
 *
 *   (node:1234) ExperimentalWarning: SQLite is an experimental feature...
 *
 * That is deliberate API choice, not a user-actionable problem, and it lands
 * in the stderr stream the MCP client surfaces as server logs. Only this one
 * warning is dropped; every other warning keeps its default handler.
 */
const originalEmit = process.emit;

process.emit = function patchedEmit(
  this: NodeJS.Process,
  event: string | symbol,
  ...args: unknown[]
): boolean {
  if (event === "warning") {
    const warning: unknown = args[0];
    if (
      warning instanceof Error &&
      warning.name === "ExperimentalWarning" &&
      /SQLite/i.test(warning.message)
    ) {
      return false;
    }
  }
  return (originalEmit as (...emitArgs: unknown[]) => boolean).call(
    this,
    event,
    ...args,
  );
} as typeof process.emit;

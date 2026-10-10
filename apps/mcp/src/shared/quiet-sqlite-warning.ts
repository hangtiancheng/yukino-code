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

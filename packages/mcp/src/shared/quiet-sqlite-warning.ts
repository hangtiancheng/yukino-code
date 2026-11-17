/* eslint-disable @typescript-eslint/consistent-type-assertions */
type EmitSignature = (event: string | symbol, ...args: unknown[]) => boolean;

const originalEmit = process.emit.bind(process) as EmitSignature;

process.emit = function patchedEmit(
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
  return originalEmit(event, ...args);
} as typeof process.emit;

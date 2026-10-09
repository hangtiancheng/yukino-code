import { runA2aServer } from "./server.js";

// Submodule namespaces for library consumers (A2a.Card.*, A2a.Server.*, ...).
// Namespaced re-exports keep submodule symbols out of the flat barrel, so they
// cannot collide with other groups' `export *` names.
export * as Card from "./card.js";
export * as Conversion from "./conversion.js";
export * as Executor from "./executor.js";
export * as Server from "./server.js";

export interface A2aMode {
  address?: string;
}

export function parseA2aMode(args: string[]): A2aMode | null {
  const index = args.indexOf("--a2a");
  if (index === -1) {
    return null;
  }
  const address = args[index + 1];
  const consumed = address && !address.startsWith("-") ? 2 : 1;
  if (args.length !== consumed) {
    throw new Error(
      "--a2a accepts only an optional port or host:port address.",
    );
  }
  return consumed === 2 ? { address } : {};
}

export async function runA2a(args: string[]): Promise<void> {
  const mode = parseA2aMode(args);
  if (!mode) {
    throw new Error("A2A mode was not selected.");
  }
  await runA2aServer(mode.address);
}

// Submodule namespaces for library consumers (A2a.Card.*, A2a.Server.*, ...).
// Namespaced re-exports keep submodule symbols out of the flat barrel, so they
// cannot collide with other groups' `export *` names.
export * as Card from "./card.js";
export * as Conversion from "./conversion.js";
export * as Executor from "./executor.js";
export * as Server from "./server.js";

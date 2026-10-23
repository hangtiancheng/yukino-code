// Submodule namespaces for library consumers (A2a.Card.*, A2a.Server.*, ...).
// Namespaced re-exports keep submodule symbols out of the flat barrel, so they
// cannot collide with other groups' `export *` names.
export * from "./card.js";
export * from "./constants.js";
export * from "./conversion.js";
export * from "./executor.js";
export * from "./prompts.js";
export * from "./server.js";

// Submodule namespaces for library consumers (A2a.Card.*, A2a.Server.*, ...).
// Namespaced re-exports keep submodule symbols out of the flat barrel, so they
// cannot collide with other groups' `export *` names.
export * as Card from "@/a2a/card.js";
export * as Constants from "@/a2a/constants.js";
export * as Conversion from "@/a2a/conversion.js";
export * as Executor from "@/a2a/executor.js";
export * as Prompts from "@/a2a/prompts.js";
export * as Server from "@/a2a/server.js";

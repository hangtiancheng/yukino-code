// Submodule namespaces for library consumers (Acp.Agent.*, Acp.Stdio.*, ...).
// Namespaced re-exports keep submodule symbols out of the flat barrel, so they
// cannot collide with other groups' `export *` names.
export * from "./agent.js";
export * from "./constants.js";
export * from "./conversion.js";
export * from "./stdio.js";
export * from "./websocket.js";

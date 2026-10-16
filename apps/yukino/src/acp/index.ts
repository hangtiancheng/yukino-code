// Submodule namespaces for library consumers (Acp.Agent.*, Acp.Stdio.*, ...).
// Namespaced re-exports keep submodule symbols out of the flat barrel, so they
// cannot collide with other groups' `export *` names.
export * as Agent from "./agent.js";
export * as Conversion from "./conversion.js";
export * as Stdio from "./stdio.js";
export * as Websocket from "./websocket.js";

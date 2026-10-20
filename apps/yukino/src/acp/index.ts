// Submodule namespaces for library consumers (Acp.Agent.*, Acp.Stdio.*, ...).
// Namespaced re-exports keep submodule symbols out of the flat barrel, so they
// cannot collide with other groups' `export *` names.
export * as Agent from "@/acp/agent.js";
export * as Constants from "@/acp/constants.js";
export * as Conversion from "@/acp/conversion.js";
export * as Stdio from "@/acp/stdio.js";
export * as Websocket from "@/acp/websocket.js";

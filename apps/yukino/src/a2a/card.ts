import type { AgentCard, AgentInterface } from "@a2a-js/sdk";

import { version } from "@/version.js";

const DESCRIPTION =
  "Yukino is a terminal-based AI coding agent. It reads, edits, and creates " +
  "files, runs shell commands, and drives multi-step coding tasks from " +
  "natural language instructions.";

const SKILL_DESCRIPTION =
  "Executes software engineering tasks: answering questions about a codebase, " +
  "writing and refactoring code, running commands, and fixing bugs.";

/**
 * Builds the agent card for the given base URL. Both the JSON-RPC endpoint
 * (POST /) and the HTTP+JSON/REST endpoints (/v1/...) are served from the
 * same origin, so both interfaces share the URL.
 */
export function buildAgentCard(url: string): AgentCard {
  const interfaces: AgentInterface[] = [
    { url, protocolBinding: "JSONRPC", protocolVersion: "1.0", tenant: "" },
    { url, protocolBinding: "HTTP+JSON", protocolVersion: "1.0", tenant: "" },
  ];
  return {
    name: "yukino",
    description: DESCRIPTION,
    supportedInterfaces: interfaces,
    provider: undefined,
    version,
    capabilities: {
      streaming: true,
      pushNotifications: false,
      extensions: [],
    },
    securitySchemes: {},
    securityRequirements: [],
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/plain"],
    skills: [
      {
        id: "coding",
        name: "Coding",
        description: SKILL_DESCRIPTION,
        tags: ["code", "development", "programming"],
        examples: [
          "Fix the failing tests in this repository.",
          "Add a dark mode toggle to the settings page.",
        ],
        inputModes: ["text/plain"],
        outputModes: ["text/plain"],
        securityRequirements: [],
      },
    ],
    signatures: [],
  };
}

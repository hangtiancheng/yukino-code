import type { AgentCard, AgentInterface } from "@a2a-js/sdk";

import { A2A_PROTOCOL_VERSION } from "./constants.js";
import { DESCRIPTION, SKILL_DESCRIPTION, SKILL_EXAMPLES } from "./prompts.js";
import { version } from "@yukino.js/version";

/**
 * Builds the agent card for the given base URL. Both the JSON-RPC endpoint
 * (POST /) and the HTTP+JSON/REST endpoints (/v1/...) are served from the
 * same origin, so both interfaces share the URL.
 */
export function buildAgentCard(url: string): AgentCard {
  const interfaces: AgentInterface[] = [
    {
      url,
      protocolBinding: "JSONRPC",
      protocolVersion: A2A_PROTOCOL_VERSION,
      tenant: "",
    },
    {
      url,
      protocolBinding: "HTTP+JSON",
      protocolVersion: A2A_PROTOCOL_VERSION,
      tenant: "",
    },
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
        examples: SKILL_EXAMPLES,
        inputModes: ["text/plain"],
        outputModes: ["text/plain"],
        securityRequirements: [],
      },
    ],
    signatures: [],
  };
}

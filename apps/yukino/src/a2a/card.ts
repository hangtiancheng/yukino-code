import type { AgentCard, AgentInterface } from "@a2a-js/sdk";
import { z } from "zod";

import {
  A2A_PROTOCOL_VERSION,
  PERMISSION_EXTENSION_URI,
} from "@/a2a/constants.js";
import {
  PermissionRequestDataSchema,
  PermissionResponseDataSchema,
} from "@/a2a/conversion.js";
import {
  DESCRIPTION,
  PERMISSION_EXTENSION_DESCRIPTION,
  SKILL_DESCRIPTION,
  SKILL_EXAMPLES,
} from "@/a2a/prompts.js";
import { version } from "@/version.js";

/**
 * Builds the agent card for the given base URL. Both the JSON-RPC endpoint
 * (POST /) and the HTTP+JSON/REST endpoints (/v1/...) are served from the
 * same origin. The REST interface includes its /v1/ route prefix.
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
      url: new URL("v1/", url).href,
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
      extensions: [
        {
          uri: PERMISSION_EXTENSION_URI,
          description: PERMISSION_EXTENSION_DESCRIPTION,
          required: false,
          params: {
            decisions: ["allow", "deny", "allowAlways"],
            versionHeader: "A2A-Version: 1.0",
            requestSchema: z.toJSONSchema(PermissionRequestDataSchema),
            responseSchema: z.toJSONSchema(PermissionResponseDataSchema),
          },
        },
      ],
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

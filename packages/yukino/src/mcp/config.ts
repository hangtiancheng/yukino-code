import { z } from "zod";

export const MCPExposureSchema = z.enum([
  "direct",
  "deferred",
  "codemode",
  "hidden",
]);
export type MCPExposure = z.infer<typeof MCPExposureSchema>;

export const MCPOAuthConfigSchema = z
  .strictObject({
    issuer: z.url(),
    resource: z.url().optional(),
    client_id: z.string().min(1).optional(),
    client_secret: z.string().min(1).optional(),
    registration: z.enum(["registered", "dynamic"]).optional(),
    scope: z.string().optional(),
    callback: z
      .discriminatedUnion("mode", [
        z.strictObject({
          mode: z.literal("loopback"),
          port: z.number().int().min(0).max(65535).optional(),
        }),
        z.strictObject({ mode: z.literal("headless"), redirect_uri: z.url() }),
      ])
      .optional(),
  })
  .superRefine((value, ctx) => {
    if (value.registration !== "dynamic" && !value.client_id) {
      ctx.addIssue({
        code: "custom",
        message:
          "OAuth requires a registered client_id or explicit dynamic registration",
      });
    }
    if (value.client_secret && !value.client_id) {
      ctx.addIssue({
        code: "custom",
        message: "client_secret requires client_id",
      });
    }
  });
export type MCPOAuthConfig = z.infer<typeof MCPOAuthConfigSchema>;

export const MCPServerConfigSchema = z
  .strictObject({
    name: z.string().min(1),
    enabled: z.boolean().optional(),
    command: z.string().min(1).optional(),
    args: z.array(z.string()).optional(),
    url: z
      .union([
        z.url(),
        z
          .string()
          .regex(
            /^(?:\$\{[A-Za-z_]\w*(?::-[^${}]*)?\}|\$[A-Za-z_]\w*|https?:\/\/[^\s]*\$\{[A-Za-z_]\w*(?::-[^${}]*)?\}[^\s]*|https?:\/\/[^\s]*\$[A-Za-z_]\w*[^\s]*)$/u,
          ),
      ])
      .optional(),
    transport: z.enum(["stdio", "http"]).optional(),
    headers: z.record(z.string(), z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
    inherit_env: z.boolean().optional(),
    cwd: z.string().optional(),
    exposure: MCPExposureSchema.optional(),
    tool_exposure: z
      .array(
        z.strictObject({
          tool: z.string().min(1),
          exposure: MCPExposureSchema,
        }),
      )
      .optional(),
    oauth: MCPOAuthConfigSchema.optional(),
    dynamic: z.boolean().optional(),
  })
  .superRefine((value, ctx) => {
    if (
      (value.command && value.url) ||
      (value.enabled !== false && !value.command && !value.url)
    ) {
      ctx.addIssue({
        code: "custom",
        message: "MCP requires exactly one of command or url",
      });
    }
    if (
      (value.command && value.transport && value.transport !== "stdio") ||
      (value.url && value.transport === "stdio")
    ) {
      ctx.addIssue({
        code: "custom",
        message: "MCP transport does not match its endpoint",
      });
    }
    if (value.oauth && !value.url) {
      ctx.addIssue({
        code: "custom",
        message: "OAuth requires Streamable HTTP",
      });
    }
    if (
      value.oauth &&
      Object.keys(value.headers ?? {}).some((key) =>
        /^(authorization|cookie|proxy-authorization)$/i.test(key),
      )
    ) {
      ctx.addIssue({
        code: "custom",
        message: "OAuth cannot be combined with credential headers",
      });
    }
    const exact = new Set<string>();
    for (const rule of value.tool_exposure ?? []) {
      if (!rule.tool.includes("*")) {
        if (exact.has(rule.tool)) {
          ctx.addIssue({
            code: "custom",
            message: "Duplicate exact tool exposure rule",
          });
        }
        exact.add(rule.tool);
      }
    }
  });
export type MCPServerConfig = z.infer<typeof MCPServerConfigSchema>;

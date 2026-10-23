import z from "zod";

import {
  FILE_EXTENSION_PATTERN,
  FILE_EXTENSION_REQUIRED_ERROR,
} from "./constants.js";

export const LspServerConfigSchema = z.object({
  name: z.string().trim().min(1),
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  languages: z
    .record(z.string().regex(FILE_EXTENSION_PATTERN), z.string().min(1))
    .refine(
      (languages) => Object.keys(languages).length > 0,
      FILE_EXTENSION_REQUIRED_ERROR,
    ),
  env: z.record(z.string(), z.string()).optional(),
  initialization_options: z.record(z.string(), z.unknown()).optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
  timeout_ms: z.number().int().min(100).max(60_000).optional(),
});

export type LspServerConfig = z.infer<typeof LspServerConfigSchema>;

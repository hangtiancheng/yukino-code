import { z } from "zod";

export const ProviderIdentityInputSchema = z.strictObject({
  name: z.string().trim().min(1, "Name is required"),
  base_url: z
    .url("Enter a valid HTTP(S) URL")
    .refine((url) => /^https?:\/\//i.test(url), "Use an HTTP(S) URL"),
  api_key: z.string().trim().min(1, "API key is required"),
  model: z.string().trim().min(1, "Model is required"),
});

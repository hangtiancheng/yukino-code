import { fileURLToPath } from "url";
import { defineConfig } from "vitest/config";
import { resolve, dirname } from "path";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
  },
  resolve: {
    alias: {
      "@": resolve(dirname(fileURLToPath(import.meta.url)), "src"),
    },
  },
});

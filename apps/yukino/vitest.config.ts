import { resolve } from "node:path";

import { defineConfig } from "vitest/config";

const repoRoot = resolve(import.meta.dirname, "../..");

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@yukino\.js\/(?!yukino(?:\/|$))([a-z0-9-]+)\/(.*)$/,
        replacement: resolve(repoRoot, "packages/$1/src/$2"),
      },
      {
        find: /^@yukino\.js\/(?!yukino$)([a-z0-9-]+)$/,
        replacement: resolve(repoRoot, "packages/$1/src/index.ts"),
      },
      {
        find: /^@\/(.*)$/,
        replacement: resolve(import.meta.dirname, "src/$1"),
      },
      {
        find: /^#\/(.*)$/,
        replacement: resolve(repoRoot, "packages/browser/src/$1"),
      },
    ],
  },
  test: {
    setupFiles: ["tests/setup.ts"],
    include: ["tests/**/*.test.{ts,tsx}"],
    environment: "node",
    testTimeout: 100_000,
    coverage: {
      provider: "v8",
      include: ["src/**/*.{ts,tsx}", "../../packages/*/src/**/*.{ts,tsx}"],
      exclude: ["src/**/*.d.ts", "../../packages/browser/**"],
      reporter: ["html", "json-summary", "lcov", "text"],
      reportsDirectory: "coverage",
    },
  },
});

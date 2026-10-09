// @ts-check

import { copyFileSync } from "node:fs";
import { defineConfig } from "tsup";

export default defineConfig((options) => ({
  entry: { index: "src/index.tsx" },
  format: ["esm"],
  platform: "browser",
  target: "es2020",
  outDir: "dist/static",
  outExtension: () => ({ js: ".js" }),
  clean: true,
  minify: !options.watch,
  sourcemap: !!options.watch,
  env: { NODE_ENV: options.watch ? "development" : "production" },
  onSuccess: async () => {
    copyFileSync("index.html", "dist/index.html");
  },
}));

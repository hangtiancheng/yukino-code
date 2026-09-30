import { readFileSync } from "node:fs";

import { defineConfig } from "tsup";

const pkg: unknown = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf-8"),
);
const version =
  typeof pkg === "object" &&
  pkg !== null &&
  "version" in pkg &&
  typeof pkg.version === "string"
    ? pkg.version
    : "0.0.0";

export default defineConfig({
  entry: ["src/main.ts"],
  format: ["esm"],
  platform: "node",
  target: "node20",
  outDir: "dist",
  clean: true,
  banner: {
    js: [
      "#!/usr/bin/env node",
      // Bundled CJS deps (dotenv) call require() dynamically; provide it in
      // the ESM bundle or Node throws "Dynamic require of ... is not supported".
      'import { createRequire } from "node:module";',
      "const require = createRequire(import.meta.url);",
    ].join("\n"),
  },
  define: { __YUKINO_MCP_VERSION__: JSON.stringify(version) },
  tsconfig: "tsconfig.json",
});

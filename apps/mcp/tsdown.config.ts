import { readFileSync } from "node:fs";

import { defineConfig } from "tsdown";

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
  target: "node24",
  outDir: "dist",
  clean: true,
  minify: false,
  dts: false,
  // The bin entry is dist/main.js ("type": "module"), so emit .js, not .mjs.
  fixedExtension: false,
  sourcemap: false,
  env: {
    NODE_ENV: "production",
  },
  banner: {
    js: [
      "#!/usr/bin/env node",
      // Provide a real `require` for bundled CJS modules. The import is
      // aliased because the bundle itself may import createRequire by name.
      'import { createRequire as __yukinoMcpCreateRequire } from "node:module";',
      "const require = __yukinoMcpCreateRequire(import.meta.url);",
    ].join("\n"),
  },
  define: { __YUKINO_MCP_VERSION__: JSON.stringify(version) },
  tsconfig: "tsconfig.json",
});

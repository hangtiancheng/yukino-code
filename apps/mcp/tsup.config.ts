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
  target: "node24",
  // tsup strips the `node:` prefix from builtin specifiers by default. That is
  // fine for legacy builtins — Node resolves `fs` and `path` bare as well — but
  // `sqlite` is a prefix-only builtin, so the emitted
  // `import { DatabaseSync } from "sqlite"` fails at startup with
  // ERR_MODULE_NOT_FOUND. Keep the prefix intact.
  removeNodeProtocol: false,
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

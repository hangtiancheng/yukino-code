import tailwindcss from "@tailwindcss/vite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const DEFAULT_BASE = "/yukino-code/";

const yukinoPackage = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../yukino/package.json", import.meta.url)),
    "utf-8",
  ),
) as { version: string };

export default defineConfig(({ command }) => ({
  base: process.env.DOCS_BASE ?? (command === "build" ? DEFAULT_BASE : "/"),
  define: {
    __YUKINO_VERSION__: JSON.stringify(yukinoPackage.version),
  },
  plugins: [tailwindcss()],

  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
}));

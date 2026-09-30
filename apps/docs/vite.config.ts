import tailwindcss from "@tailwindcss/vite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// GitHub Pages serves project sites from /<repo>/, so production builds default
// to the yukino-code base path. Override with DOCS_BASE (e.g. for a custom
// domain or a root-level user/org page).
const DEFAULT_BASE = "/yukino-code/";

// The site advertises the CLI's version; read it from the sibling package at
// config time so it can never go stale.
const yukinoPackage = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../yukino/package.json", import.meta.url)),
    "utf-8",
  ),
) as { version: string };

// https://vite.dev/config/
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

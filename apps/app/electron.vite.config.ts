import { fileURLToPath } from "node:url";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";

const sharedAlias = {
  "@main": fileURLToPath(new URL("src/main", import.meta.url)),
  "@preload": fileURLToPath(new URL("src/preload", import.meta.url)),
  "@renderer": fileURLToPath(new URL("src/renderer/src", import.meta.url)),
  "@shared": fileURLToPath(new URL("src/shared", import.meta.url)),
};

export default defineConfig({
  main: {
    // @yukino.js/yukino is ESM-only; keep it and every other dependency
    // external so they resolve from node_modules at runtime (Node 22.12+
    // require(esm) support in Electron).
    plugins: [],
    build: {
      externalizeDeps: true,
    },
    resolve: {
      alias: sharedAlias,
    },
  },
  preload: {
    plugins: [],
    build: {
      externalizeDeps: true,
    },
    resolve: {
      alias: sharedAlias,
    },
  },
  renderer: {
    resolve: {
      alias: sharedAlias,
    },
    plugins: [react(), tailwindcss()],
  },
});

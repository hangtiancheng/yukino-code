import { fileURLToPath } from "node:url";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

// Bundles the create_app UI shell into a single self-contained HTML file.
// tsup runs first and cleans dist/, so this build must not empty the outDir.
export default defineConfig({
  root: fileURLToPath(new URL("./src/tools/create-app", import.meta.url)),
  plugins: [react(), tailwindcss(), viteSingleFile()],
  build: {
    outDir: fileURLToPath(new URL("./dist", import.meta.url)),
    emptyOutDir: false,
    rollupOptions: {
      input: "create-app.html",
    },
  },
});

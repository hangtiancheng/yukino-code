import { fileURLToPath } from "node:url";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: fileURLToPath(new URL("../src/renderer", import.meta.url)),
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@renderer": fileURLToPath(
        new URL("../src/renderer/src", import.meta.url),
      ),
      "@shared": fileURLToPath(new URL("../src/shared", import.meta.url)),
    },
  },
  server: { host: "127.0.0.1", port: 5179, strictPort: true },
});

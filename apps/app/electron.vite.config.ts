import { defineConfig } from "electron-vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  main: {
    resolve: {
      alias: {
        "@main": fileURLToPath(new URL("src/main", import.meta.url)),
        "@preload": fileURLToPath(new URL("src/preload", import.meta.url)),
        "@renderer": fileURLToPath(
          new URL("src/renderer/src", import.meta.url),
        ),
      },
    },
  },
  preload: {
    resolve: {
      alias: {
        "@main": fileURLToPath(new URL("src/main", import.meta.url)),
        "@preload": fileURLToPath(new URL("src/preload", import.meta.url)),
        "@renderer": fileURLToPath(
          new URL("src/renderer/src", import.meta.url),
        ),
      },
    },
  },
  renderer: {
    resolve: {
      alias: {
        "@main": fileURLToPath(new URL("src/main", import.meta.url)),
        "@preload": fileURLToPath(new URL("src/preload", import.meta.url)),
        "@renderer": fileURLToPath(
          new URL("src/renderer/src", import.meta.url),
        ),
      },
    },
    plugins: [react(), tailwindcss()],
  },
});

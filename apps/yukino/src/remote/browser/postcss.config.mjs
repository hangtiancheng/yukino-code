import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import tailwind from "@tailwindcss/postcss";

const paletteFile = new URL("../../theme/palette.json", import.meta.url);

export default {
  plugins: [
    {
      postcssPlugin: "yukino-palette",
      Once(root, { postcss, result }) {
        const palettes = JSON.parse(readFileSync(paletteFile, "utf8"));
        result.messages.push({
          type: "dependency",
          plugin: "yukino-palette",
          file: fileURLToPath(paletteFile),
        });
        root.walkAtRules("yukino-palette", (rule) => {
          rule.replaceWith(
            ...Object.entries(palettes).map(([mode, palette]) => {
              const scheme = postcss.rule({
                selector:
                  mode === "dark"
                    ? ':root, :root[data-theme="dark"]'
                    : ':root[data-theme="light"]',
              });
              scheme.append({ prop: "color-scheme", value: mode });
              for (const [token, value] of Object.entries(palette)) {
                scheme.append({
                  prop: `--yukino-${token.replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`)}`,
                  value,
                });
              }
              return scheme;
            }),
          );
        });
      },
    },
    tailwind(),
  ],
};

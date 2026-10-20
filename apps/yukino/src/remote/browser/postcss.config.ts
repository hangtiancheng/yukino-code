import { fileURLToPath } from "node:url";

import tailwindcss from "@tailwindcss/postcss";
import { PALETTES } from "@yukino.js/yukino/theme/constants.js";
import type { Plugin } from "postcss";

function asString(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  return String(value);
}

const constantsFile: string = fileURLToPath(
  new URL("../../theme/constants.ts", import.meta.url),
);

const palettePlugin: Plugin = {
  postcssPlugin: "yukino-palette",
  Once(root, { postcss, result }) {
    result.messages.push({
      type: "dependency",
      plugin: "yukino-palette",
      file: constantsFile,
    });
    root.walkAtRules("yukino-palette", (rule) => {
      rule.replaceWith(
        ...Object.entries(PALETTES).map(([mode, palette]) => {
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
              value: asString(value),
            });
          }
          return scheme;
        }),
      );
    });
  },
};

export default {
  plugins: [palettePlugin, tailwindcss()],
};

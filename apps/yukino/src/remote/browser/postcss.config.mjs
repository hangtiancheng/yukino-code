// Plain .mjs on purpose. postcss-load-config loads a .ts config through tsx,
// and tsx's module.register() hooks collide with the registration
// @tailwindcss/node performs on Node 20 (which lacks module.registerHooks),
// failing the build. Native import() of a .mjs config keeps tsx out entirely.
import { fileURLToPath } from "node:url";

import tailwindcss from "@tailwindcss/postcss";

import { PALETTES } from "../../theme/palettes.js";

function asString(value) {
  if (typeof value === "string") {
    return value;
  }
  return String(value);
}

const palettesFile = fileURLToPath(
  new URL("../../theme/palettes.js", import.meta.url),
);

const palettePlugin = {
  postcssPlugin: "yukino-palette",
  Once(root, { postcss, result }) {
    result.messages.push({
      type: "dependency",
      plugin: "yukino-palette",
      file: palettesFile,
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

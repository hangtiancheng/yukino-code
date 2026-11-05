// Plain ESM keeps the palette usable by PostCSS without a TypeScript loader.
// Catppuccin Mocha (dark) and Latte (light).
export const CATPPUCCIN = {
  dark: {
    rosewater: "#f5e0dc",
    flamingo: "#f2cdcd",
    pink: "#f5c2e7",
    mauve: "#cba6f7",
    red: "#f38ba8",
    maroon: "#eba0ac",
    peach: "#fab387",
    yellow: "#f9e2af",
    green: "#a6e3a1",
    teal: "#94e2d5",
    sky: "#89dceb",
    sapphire: "#74c7ec",
    blue: "#89b4fa",
    lavender: "#b4befe",
    text: "#cdd6f4",
    subtext1: "#bac2de",
    subtext0: "#a6adc8",
    overlay2: "#9399b2",
    overlay1: "#7f849c",
    overlay0: "#6c7086",
    surface2: "#585b70",
    surface1: "#45475a",
    surface0: "#313244",
    base: "#1e1e2e",
    mantle: "#181825",
    crust: "#11111b",
  },
  light: {
    rosewater: "#dc8a78",
    flamingo: "#dd7878",
    pink: "#ea76cb",
    mauve: "#8839ef",
    red: "#d20f39",
    maroon: "#e64553",
    peach: "#fe640b",
    yellow: "#df8e1d",
    green: "#40a02b",
    teal: "#179299",
    sky: "#04a5e5",
    sapphire: "#209fb5",
    blue: "#1e66f5",
    lavender: "#7287fd",
    text: "#4c4f69",
    subtext1: "#5c5f77",
    subtext0: "#6c6f85",
    overlay2: "#7c7f93",
    overlay1: "#8c8fa1",
    overlay0: "#9ca0b0",
    surface2: "#acb0be",
    surface1: "#bcc0cc",
    surface0: "#ccd0da",
    base: "#eff1f5",
    mantle: "#e6e9ef",
    crust: "#dce0e8",
  },
};

function mix(background, foreground, amount) {
  const channels = [1, 3, 5].map((offset) => {
    const base = Number.parseInt(background.slice(offset, offset + 2), 16);
    const tint = Number.parseInt(foreground.slice(offset, offset + 2), 16);
    return Math.round(base + (tint - base) * amount)
      .toString(16)
      .padStart(2, "0");
  });
  return `#${channels.join("")}`;
}

function luminance(color) {
  const channels = [1, 3, 5].map((offset) => {
    const channel = Number.parseInt(color.slice(offset, offset + 2), 16) / 255;
    return channel <= 0.04045
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}

// Shade foregrounds for contrast without shifting the Catppuccin hue.
function readable(color, background, text) {
  const backgroundLuminance = luminance(background);
  const target = backgroundLuminance > luminance(color) ? "#000000" : "#ffffff";
  for (let step = 0; step <= 20; step++) {
    const candidate = mix(color, target, step / 20);
    const candidateLuminance = luminance(candidate);
    const contrast =
      (Math.max(candidateLuminance, backgroundLuminance) + 0.05) /
      (Math.min(candidateLuminance, backgroundLuminance) + 0.05);
    if (contrast >= 4.5) {
      return candidate;
    }
  }
  return text;
}

/** @param {typeof CATPPUCCIN.dark} colors */
function buildPalette(colors) {
  const surface = (color) => mix(colors.mantle, color, 0.18);
  const surfaces = [
    colors.teal,
    colors.green,
    colors.red,
    colors.yellow,
    colors.blue,
    colors.mauve,
  ].map(surface);
  const foreground = (color) =>
    surfaces.reduce(
      (value, background) => readable(value, background, colors.text),
      color,
    );
  const accent = foreground(colors.teal);
  const success = foreground(colors.green);
  const warning = foreground(colors.yellow);
  const error = foreground(colors.red);
  const heading = foreground(colors.mauve);
  return {
    background: colors.base,
    surface: colors.mantle,
    codeBg: colors.mantle,
    border: colors.surface2,
    borderMuted: colors.surface0,
    borderAccent: accent,
    text: colors.text,
    bright: colors.text,
    muted: colors.subtext1,
    dim: readable(colors.subtext0, colors.mantle, colors.text),
    accent,
    accentHover: mix(accent, colors.text, 0.12),
    accentContrast: colors.base,
    accentBg: surface(colors.teal),
    success,
    successBg: surface(colors.green),
    warning,
    warningBg: surface(colors.yellow),
    error,
    errorBg: surface(colors.red),
    selectedBg: mix(colors.base, colors.teal, 0.16),
    userMessageBg: surface(colors.blue),
    userMessageText: colors.text,
    customMessageBg: surface(colors.mauve),
    customMessageText: colors.text,
    customMessageLabel: heading,
    toolPendingBg: surface(colors.blue),
    toolSuccessBg: surface(colors.green),
    toolErrorBg: surface(colors.red),
    toolStoppedBg: surface(colors.yellow),
    toolTitle: colors.text,
    toolOutput: foreground(colors.subtext1),
    toolDiffAdded: success,
    toolDiffRemoved: error,
    toolDiffContext: foreground(colors.subtext0),
    thinkingText: colors.subtext0,
    thinkingOff: colors.subtext0,
    thinkingMinimal: colors.subtext1,
    thinkingLow: foreground(colors.blue),
    thinkingMedium: accent,
    thinkingHigh: heading,
    thinkingXHigh: foreground(colors.lavender),
    thinkingMax: foreground(colors.pink),
    bashMode: success,
    mdHeading: heading,
    mdLink: foreground(colors.blue),
    mdLinkUrl: colors.subtext0,
    mdCode: accent,
    mdCodeBlock: colors.text,
    mdCodeBlockBorder: colors.surface2,
    mdQuote: colors.subtext0,
    mdQuoteBorder: colors.surface2,
    mdHr: colors.surface2,
    mdListBullet: accent,
    syntaxComment: foreground(colors.overlay2),
    syntaxKeyword: heading,
    syntaxFunction: foreground(colors.blue),
    syntaxVariable: colors.text,
    syntaxString: success,
    syntaxNumber: foreground(colors.peach),
    syntaxType: warning,
    syntaxOperator: foreground(colors.sky),
    syntaxPunctuation: foreground(colors.overlay2),
  };
}

export const PALETTES = {
  dark: buildPalette(CATPPUCCIN.dark),
  light: buildPalette(CATPPUCCIN.light),
};

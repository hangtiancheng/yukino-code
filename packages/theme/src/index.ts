export * from "./constants.js";
// Syntax stays out of this barrel: src/index.ts re-exports Theme into the
// library entry, and syntax.ts's shiki type import would leak the ui-only
// dependency into dist/lib/index.d.ts. UI consumers import ./syntax.js directly.

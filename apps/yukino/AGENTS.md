# AGENTS.md

Yukino CLI is a terminal-based AI coding agent.

- Fix all ESLint errors. Ignore all ESLint warnings.
- Use `pnpm lint:fix` to automatically correct lint errors. This command is idempotent and non-destructive.
- ZERO backward compatibility. Breaking changes are expected, acceptable, and preferred over legacy support.
- NEVER maintain conditional logic for older versions, dead code, deprecated APIs, or shim layers. Remove them aggressively.
- If fixing a bug or updating/implementing a valuable feature causes old tests to fail, follow ZERO backward compatibility: implement the correct behavior, update or remove obsolete tests, and update all outdated comments. NEVER preserve defective behavior or add compatibility logic merely to satisfy old tests.
- Use `pnpm happy:fix` as the final validation pipeline. This command is idempotent and non-destructive.
- Only add comments where the code is not self-explanatory. Usage of these comments should be rare.

## Module constants and prompts (packages/<module>/src/)

Every workspace package under `packages/` centralizes its module-level constants in `constants.ts` and its model-facing prompt text in `prompts.ts` (create `prompts.ts` only when the module has prompt text; skip `constants.ts` when there is nothing to centralize).

- `prompts.ts` holds text sent to the LLM: system prompts, instructions, reminders, tool `description` strings, guidance rules, agent-card descriptions, and pure text-assembly functions (e.g. `buildSummaryPrompt`, `buildTeammatePrompt`).
- `constants.ts` holds everything else: numeric limits, timeouts, ratios, protocol string keys, markers, filenames, ports, sets/maps, validation regexes, config data (e.g. `THINKING_LEVELS`), and human-facing error/status messages.
- Keep in their original files: zod schemas (with their `z.infer` types), types, classes, executable payloads (`snippets.ts`, grep worker source, clipboard scripts, `CRC_TABLE`), function-local literals, and file-local implementation constants that serve one file's internals (e.g. per-dialog `FIELD_KEYS`/`FIELD_LABELS`, ported-algorithm constants in `marked-terminal.ts`).
- `constants.ts` and `prompts.ts` are leaf modules: import sibling types with `import type` and never create runtime import cycles.
- Move symbols unchanged (name, value, JSDoc travels with the symbol); extract previously unnamed literals into new SCREAMING_CASE names.
- Never add compatibility re-exports. When a symbol moves, update every importer — including `tests/` — to the new path.
- Barrels: `index.ts` files re-export their siblings flat (`export * from "./constants.js";`, `export * from "./prompts.js";`) in alphabetical order. Namespace re-exports (`export * as X`) are banned — the public API is flat named exports.
- Cross-package imports use the package specifier (`@yukino.js/<module>/<file>.js`); files inside one package import siblings relatively. The `@/` alias only covers the CLI entry files left in apps/yukino/src (cli.ts, main.tsx, index.ts, print-mode.ts, recover.ts).
- `packages/theme` is consumed by `packages/remote-browser` (and every other package) through its `@yukino.js/theme/<file>.js` exports; keep its constants browser-safe.

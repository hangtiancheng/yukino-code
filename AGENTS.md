# AGENTS.md

Yukino CLI (apps/yukino) is a terminal-based AI coding agent.

Yukino MCP server (apps/mcp) is an official collection of MCP tools for yukino

The former apps/yukino/src modules live in packages/* as source-level workspace packages (@yukino.js/<module>): their package.json "exports" map directly to ./src TypeScript sources, there is no per-package build step, and apps/yukino bundles them via tsup. The shared ESLint flat config lives at the repo root.

- Fix all ESLint errors. Ignore all ESLint warnings.
- Use `pnpm lint:fix` to automatically correct lint errors. This command is idempotent and non-destructive.
- ZERO backward compatibility. Breaking changes are expected, acceptable, and preferred over legacy support.
- NEVER maintain conditional logic for older versions, dead code, deprecated APIs, or shim layers. Remove them aggressively.
- If fixing a bug or updating/implementing a valuable feature causes old tests to fail, follow ZERO backward compatibility: implement the correct behavior, update or remove obsolete tests, and update all outdated comments. NEVER preserve defective behavior or add compatibility logic merely to satisfy old tests.
- Use `pnpm happy:fix` as the final validation pipeline. This command is idempotent and non-destructive.
- Only add comments where the code is not self-explanatory. Usage of these comments should be rare.

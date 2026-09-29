# AGENTS.md

Yukino is a terminal-based AI coding agent.

- NEVER manually add MIT license headers to any file.
- Fix all ESLint errors. Ignore all ESLint warnings.
- Use `pnpm lint:fix` to automatically correct lint errors. This command is idempotent and non-destructive.
- ZERO backward compatibility. Breaking changes are expected, acceptable, and preferred over legacy support.
- NEVER maintain conditional logic for older versions, dead code, deprecated APIs, or shim layers. Remove them aggressively.
- Use `pnpm happy:fix` as the final validation pipeline. This command is idempotent and non-destructive.
- Only add comments where the code is not self-explanatory. Usage of these comments should be rare.

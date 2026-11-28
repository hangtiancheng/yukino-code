# AGENTS.md

Yukino CLI (packages/yukino) is a terminal-based AI coding agent.

Yukino MCP server (packages/mcp) is an official collection of MCP tools for yukino

- Fix all ESLint errors. Ignore all ESLint warnings.
- Use `pnpm lint:fix` to automatically correct lint errors. This command is idempotent and non-destructive.
- ZERO backward compatibility. Breaking changes are expected, acceptable, and preferred over legacy support.
- NEVER maintain conditional logic for older versions, dead code, deprecated APIs, or shim layers. Remove them aggressively.
- If fixing a bug or updating/implementing a valuable feature causes old tests to fail, follow ZERO backward compatibility: implement the correct behavior, update or remove obsolete tests, and update all outdated comments. NEVER preserve defective behavior or add compatibility logic merely to satisfy old tests.
- Use `pnpm happy:fix` as the final validation pipeline. This command is idempotent and non-destructive.
- Only add comments where the code is not self-explanatory. Usage of these comments should be rare.
- Do not introduce dependencies that provide or require C++ native capabilities, including transitive or optional dependencies, native addons, C++ build toolchains, and prebuilt C++ binaries. `sharp` is explicitly prohibited. Check the dependency tree before adding or upgrading packages; choose alternatives without C++ native capabilities.

// Intentionally empty: the terminal UI has no public barrel. The library entry
// (src/index.ts) must never re-export src/ui — enforced at build time by the
// ban-ui-only-deps guard in tsup.config.ts — and UI modules are imported
// directly by path (e.g. "@/ui/app.js"), not through this file.

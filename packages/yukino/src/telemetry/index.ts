// Submodule namespaces for library consumers (Telemetry.<Sub>.*).
// providers.js is deliberately NOT re-exported here: it statically imports the
// optionalDependencies (@langfuse/*, @opentelemetry/*), so a static re-export
// would make the library entry unloadable when those are absent and contradict
// initializeTelemetry's guarded dynamic import + no-op fallback.
export * as Constants from "@/telemetry/constants.js";
export * as Instrumentation from "@/telemetry/instrumentation.js";
export * as Privacy from "@/telemetry/privacy.js";
export * from "./runtime.js";

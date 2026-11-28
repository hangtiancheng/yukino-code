import { EXPORTER_NONE } from "@/telemetry/constants.js";
import type { TelemetryRuntime } from "@/telemetry/runtime.js";

export function parseExporterTypes(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0 && item !== EXPORTER_NONE);
}

export async function createTelemetryRuntime(): Promise<TelemetryRuntime> {
  const { createProviderRuntime } = await import("./provider-runtime.js");
  return createProviderRuntime();
}

/**
 * Copyright (c) 2026 hangtiancheng
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

export type TelemetryMode =
  "print" | "remote" | "teammate" | "terminal" | "unknown";
export type TelemetryObservationKind = "agent" | "generation" | "tool";
export type TelemetryMetricKind = "counter" | "histogram";
export type TelemetryAttributes = Record<string, string | number | boolean>;

export interface TelemetryObservationUpdate {
  completionStartTime?: Date;
  level?: "DEFAULT" | "ERROR" | "WARNING";
  metadata?: Record<string, unknown>;
  model?: string;
  statusMessage?: string;
  usageDetails?: Record<string, number>;
}

export interface TelemetryObservation {
  end(): void;
  recordException(error: unknown): void;
  startChild(
    kind: TelemetryObservationKind,
    name: string,
    attributes?: TelemetryAttributes,
  ): TelemetryObservation;
  update(update: TelemetryObservationUpdate): void;
}

export interface TelemetryRuntime {
  captureError(error: unknown, context: string): void;
  emitLog(
    name: string,
    severity: "error" | "info" | "warn",
    attributes?: TelemetryAttributes,
  ): void;
  flush(): Promise<void>;
  recordMetric(
    name: string,
    kind: TelemetryMetricKind,
    value: number,
    attributes?: TelemetryAttributes,
  ): void;
  setMode(mode: TelemetryMode): void;
  shutdown(): Promise<void>;
  startObservation(
    kind: TelemetryObservationKind,
    name: string,
    attributes?: TelemetryAttributes,
  ): TelemetryObservation;
}

const noopObservation: TelemetryObservation = {
  end: () => undefined,
  recordException: () => undefined,
  startChild: () => noopObservation,
  update: () => undefined,
};

const noopRuntime: TelemetryRuntime = {
  captureError: () => undefined,
  emitLog: () => undefined,
  flush: () => Promise.resolve(),
  recordMetric: () => undefined,
  setMode: () => undefined,
  shutdown: () => Promise.resolve(),
  startObservation: () => noopObservation,
};

let runtime = noopRuntime;
let mode: TelemetryMode = "unknown";
let initialization: Promise<void> | null = null;
let shutdown: Promise<void> | null = null;
let remoteSignalHandlersInstalled = false;

function hasExporter(value: string | undefined): boolean {
  return (
    value
      ?.split(",")
      .map((item) => item.trim())
      .some((item) => item.length > 0 && item !== "none") ?? false
  );
}

function shouldInitialize(): boolean {
  const otelEnabled = process.env.OTEL_SDK_DISABLED?.toLowerCase() !== "true";
  const hasOtelExporter =
    hasExporter(process.env.OTEL_TRACES_EXPORTER) ||
    hasExporter(process.env.OTEL_LOGS_EXPORTER) ||
    hasExporter(process.env.OTEL_METRICS_EXPORTER);
  const hasLangfuse = Boolean(
    process.env.LANGFUSE_PUBLIC_KEY && process.env.LANGFUSE_SECRET_KEY,
  );
  return (
    Boolean(process.env.SENTRY_DSN) ||
    (otelEnabled && (hasOtelExporter || hasLangfuse))
  );
}

export function getTelemetryRuntime(): TelemetryRuntime {
  return runtime;
}

export async function initializeTelemetry(): Promise<void> {
  if (initialization) {
    return initialization;
  }
  if (!shouldInitialize()) {
    return;
  }

  initialization = import("./providers.js")
    .then(async ({ createTelemetryRuntime }) => {
      runtime = await createTelemetryRuntime();
      runtime.setMode(mode);
      process.once("beforeExit", () => {
        void flushTelemetry();
      });
    })
    .catch(() => {
      runtime = noopRuntime;
    });

  return initialization;
}

export function setTelemetryMode(nextMode: TelemetryMode): void {
  mode = nextMode;
  runtime.setMode(nextMode);
}

export function captureTelemetryError(error: unknown, context: string): void {
  runtime.captureError(error, context);
}

export async function flushTelemetry(): Promise<void> {
  await initialization;
  await runtime.flush();
}

export async function shutdownTelemetry(): Promise<void> {
  if (shutdown) {
    return shutdown;
  }

  shutdown = (async () => {
    await initialization;
    await runtime.shutdown();
    runtime = noopRuntime;
  })();
  return shutdown;
}

export function installRemoteTelemetrySignalHandlers(): void {
  if (remoteSignalHandlersInstalled) {
    return;
  }
  remoteSignalHandlersInstalled = true;

  const install = (signal: NodeJS.Signals, exitCode: number): void => {
    const handler = (): void => {
      process.off(signal, handler);
      void shutdownTelemetry().finally(() => {
        process.exit(exitCode);
      });
    };
    process.once(signal, handler);
  };

  install("SIGINT", 130);
  install("SIGTERM", 143);
}

// Submodule namespaces for library consumers (Telemetry.<Sub>.*).
export * as Instrumentation from "./instrumentation.js";
export * as Providers from "./providers.js";

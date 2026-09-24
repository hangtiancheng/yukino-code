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

import { LangfuseSpanProcessor } from "@langfuse/otel";
import {
  setLangfuseTracerProvider,
  startObservation,
  type LangfuseObservation,
} from "@langfuse/tracing";
import {
  SpanStatusCode,
  type Counter,
  type Histogram,
  type Meter,
} from "@opentelemetry/api";
import { SeverityNumber, type Logger } from "@opentelemetry/api-logs";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  BatchLogRecordProcessor,
  ConsoleLogRecordExporter,
  LoggerProvider,
  type LogRecordExporter,
} from "@opentelemetry/sdk-logs";
import {
  ConsoleMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
  type IMetricReader,
  type PushMetricExporter,
} from "@opentelemetry/sdk-metrics";
import {
  BasicTracerProvider,
  BatchSpanProcessor,
  ConsoleSpanExporter,
  type SpanExporter,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from "@opentelemetry/semantic-conventions";
import type * as Sentry from "@sentry/node";

import type {
  TelemetryAttributes,
  TelemetryMetricKind,
  TelemetryMode,
  TelemetryObservation,
  TelemetryObservationKind,
  TelemetryObservationUpdate,
  TelemetryRuntime,
} from "./index.js";

import { version } from "@/version.js";

type OtlpProtocol = "grpc" | "http/json" | "http/protobuf";
type SentryModule = typeof Sentry;

const DEFAULT_EXPORT_INTERVAL_MS = 60_000;
const SHUTDOWN_TIMEOUT_MS = 2_000;

export function parseExporterTypes(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0 && item !== "none");
}

function parsePositiveInteger(
  value: string | undefined,
  fallback: number,
): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function getProtocol(signal: "logs" | "metrics" | "traces"): OtlpProtocol {
  const signalKey = `OTEL_EXPORTER_OTLP_${signal.toUpperCase()}_PROTOCOL`;
  const configured =
    process.env[signalKey]?.trim() ||
    process.env.OTEL_EXPORTER_OTLP_PROTOCOL?.trim();
  const protocol = configured || "http/protobuf";
  if (
    protocol === "grpc" ||
    protocol === "http/json" ||
    protocol === "http/protobuf"
  ) {
    return protocol;
  }
  throw new Error(`Unsupported OpenTelemetry protocol: ${protocol}`);
}

function parseResourceAttributes(
  value: string | undefined,
): TelemetryAttributes {
  const attributes: TelemetryAttributes = {};
  for (const entry of value?.split(",") ?? []) {
    const separator = entry.indexOf("=");
    if (separator <= 0) {
      continue;
    }
    const key = entry.slice(0, separator).trim();
    const rawValue = entry.slice(separator + 1).trim();
    if (key && rawValue) {
      try {
        attributes[decodeURIComponent(key)] = decodeURIComponent(rawValue);
      } catch {
        attributes[key] = rawValue;
      }
    }
  }
  return attributes;
}

function createResource() {
  return resourceFromAttributes({
    [ATTR_SERVICE_NAME]: "yukino",
    [ATTR_SERVICE_VERSION]: version,
    ...parseResourceAttributes(process.env.OTEL_RESOURCE_ATTRIBUTES),
    ...(process.env.OTEL_SERVICE_NAME
      ? { [ATTR_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME }
      : {}),
  });
}

async function createTraceExporter(
  protocol: OtlpProtocol,
): Promise<SpanExporter> {
  switch (protocol) {
    case "grpc": {
      const { OTLPTraceExporter } =
        await import("@opentelemetry/exporter-trace-otlp-grpc");
      return new OTLPTraceExporter();
    }
    case "http/json": {
      const { OTLPTraceExporter } =
        await import("@opentelemetry/exporter-trace-otlp-http");
      return new OTLPTraceExporter();
    }
    case "http/protobuf": {
      const { OTLPTraceExporter } =
        await import("@opentelemetry/exporter-trace-otlp-proto");
      return new OTLPTraceExporter();
    }
  }
}

async function createLogExporter(
  protocol: OtlpProtocol,
): Promise<LogRecordExporter> {
  switch (protocol) {
    case "grpc": {
      const { OTLPLogExporter } =
        await import("@opentelemetry/exporter-logs-otlp-grpc");
      return new OTLPLogExporter();
    }
    case "http/json": {
      const { OTLPLogExporter } =
        await import("@opentelemetry/exporter-logs-otlp-http");
      return new OTLPLogExporter();
    }
    case "http/protobuf": {
      const { OTLPLogExporter } =
        await import("@opentelemetry/exporter-logs-otlp-proto");
      return new OTLPLogExporter();
    }
  }
}

async function createMetricExporter(
  protocol: OtlpProtocol,
): Promise<PushMetricExporter> {
  switch (protocol) {
    case "grpc": {
      const { OTLPMetricExporter } =
        await import("@opentelemetry/exporter-metrics-otlp-grpc");
      return new OTLPMetricExporter();
    }
    case "http/json": {
      const { OTLPMetricExporter } =
        await import("@opentelemetry/exporter-metrics-otlp-http");
      return new OTLPMetricExporter();
    }
    case "http/protobuf": {
      const { OTLPMetricExporter } =
        await import("@opentelemetry/exporter-metrics-otlp-proto");
      return new OTLPMetricExporter();
    }
  }
}

async function createTracerProvider(
  resource: ReturnType<typeof createResource>,
): Promise<BasicTracerProvider | null> {
  const processors: SpanProcessor[] = [];
  const exporterTypes = parseExporterTypes(process.env.OTEL_TRACES_EXPORTER);
  for (const exporterType of exporterTypes) {
    if (exporterType === "console") {
      processors.push(new BatchSpanProcessor(new ConsoleSpanExporter()));
    } else if (exporterType === "otlp") {
      processors.push(
        new BatchSpanProcessor(
          await createTraceExporter(getProtocol("traces")),
        ),
      );
    } else {
      throw new Error(`Unsupported trace exporter: ${exporterType}`);
    }
  }

  if (process.env.LANGFUSE_PUBLIC_KEY && process.env.LANGFUSE_SECRET_KEY) {
    processors.push(
      new LangfuseSpanProcessor({
        mediaUploadEnabled: false,
        release: process.env.LANGFUSE_RELEASE ?? version,
      }),
    );
  }

  if (processors.length === 0) {
    return null;
  }

  const provider = new BasicTracerProvider({
    resource,
    spanProcessors: processors,
  });
  setLangfuseTracerProvider(provider);
  return provider;
}

async function createLoggerProvider(
  resource: ReturnType<typeof createResource>,
): Promise<LoggerProvider | null> {
  const processors: BatchLogRecordProcessor[] = [];
  for (const exporterType of parseExporterTypes(
    process.env.OTEL_LOGS_EXPORTER,
  )) {
    let exporter: LogRecordExporter;
    if (exporterType === "console") {
      exporter = new ConsoleLogRecordExporter();
    } else if (exporterType === "otlp") {
      exporter = await createLogExporter(getProtocol("logs"));
    } else {
      throw new Error(`Unsupported log exporter: ${exporterType}`);
    }
    processors.push(new BatchLogRecordProcessor({ exporter }));
  }
  return processors.length > 0
    ? new LoggerProvider({ resource, processors })
    : null;
}

async function createMetricReaders(): Promise<IMetricReader[]> {
  const readers: IMetricReader[] = [];
  const exportIntervalMillis = parsePositiveInteger(
    process.env.OTEL_METRIC_EXPORT_INTERVAL,
    DEFAULT_EXPORT_INTERVAL_MS,
  );

  for (const exporterType of parseExporterTypes(
    process.env.OTEL_METRICS_EXPORTER,
  )) {
    if (exporterType === "prometheus") {
      const { PrometheusExporter } =
        await import("@opentelemetry/exporter-prometheus");
      readers.push(new PrometheusExporter());
      continue;
    }

    let exporter: PushMetricExporter;
    if (exporterType === "console") {
      exporter = new ConsoleMetricExporter();
    } else if (exporterType === "otlp") {
      exporter = await createMetricExporter(getProtocol("metrics"));
    } else {
      throw new Error(`Unsupported metric exporter: ${exporterType}`);
    }
    readers.push(
      new PeriodicExportingMetricReader({ exporter, exportIntervalMillis }),
    );
  }

  return readers;
}

async function initializeSentry(): Promise<SentryModule | null> {
  if (!process.env.SENTRY_DSN) {
    return null;
  }

  const sentry = await import("@sentry/node");
  sentry.init({
    debug: process.env.SENTRY_DEBUG?.toLowerCase() === "true",
    dsn: process.env.SENTRY_DSN,
    environment: process.env.SENTRY_ENVIRONMENT,
    includeLocalVariables: false,
    integrations: (defaultIntegrations) =>
      defaultIntegrations.filter(
        (integration) =>
          integration.name !== "OnUncaughtException" &&
          integration.name !== "OnUnhandledRejection",
      ),
    registerEsmLoaderHooks: false,
    release: process.env.SENTRY_RELEASE ?? version,
    sendDefaultPii: false,
    skipOpenTelemetrySetup: true,
    tracesSampleRate: 0,
  });
  return sentry;
}

async function safely<T>(operation: () => Promise<T>): Promise<T | null> {
  try {
    return await operation();
  } catch {
    return null;
  }
}

function withTimeout(operation: Promise<void>): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, SHUTDOWN_TIMEOUT_MS);
    timer.unref();
    void operation.then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      () => {
        clearTimeout(timer);
        resolve();
      },
    );
  });
}

function severityNumber(severity: "error" | "info" | "warn"): SeverityNumber {
  switch (severity) {
    case "error":
      return SeverityNumber.ERROR;
    case "info":
      return SeverityNumber.INFO;
    case "warn":
      return SeverityNumber.WARN;
  }
}

function createRootObservation(
  kind: TelemetryObservationKind,
  name: string,
  attributes: TelemetryAttributes,
): LangfuseObservation {
  switch (kind) {
    case "agent":
      return startObservation(
        name,
        { metadata: attributes },
        { asType: "agent" },
      );
    case "generation": {
      const model =
        typeof attributes.model === "string" ? attributes.model : undefined;
      return startObservation(
        name,
        { metadata: attributes, model },
        { asType: "generation" },
      );
    }
    case "tool":
      return startObservation(
        name,
        { metadata: attributes },
        { asType: "tool" },
      );
  }
}

function createChildObservation(
  parent: LangfuseObservation,
  kind: TelemetryObservationKind,
  name: string,
  attributes: TelemetryAttributes,
): LangfuseObservation {
  switch (kind) {
    case "agent":
      return parent.startObservation(
        name,
        { metadata: attributes },
        { asType: "agent" },
      );
    case "generation": {
      const model =
        typeof attributes.model === "string" ? attributes.model : undefined;
      return parent.startObservation(
        name,
        { metadata: attributes, model },
        { asType: "generation" },
      );
    }
    case "tool":
      return parent.startObservation(
        name,
        { metadata: attributes },
        { asType: "tool" },
      );
  }
}

class ProviderObservation implements TelemetryObservation {
  constructor(private readonly observation: LangfuseObservation) {}

  end(): void {
    this.observation.end();
  }

  recordException(error: unknown): void {
    const errorType = error instanceof Error ? error.name : typeof error;
    this.observation.otelSpan.setAttribute("error.type", errorType);
    this.observation.otelSpan.setStatus({ code: SpanStatusCode.ERROR });
    this.observation.updateOtelSpanAttributes({
      level: "ERROR",
      statusMessage: errorType,
    });
  }

  startChild(
    kind: TelemetryObservationKind,
    name: string,
    attributes: TelemetryAttributes = {},
  ): TelemetryObservation {
    return new ProviderObservation(
      createChildObservation(this.observation, kind, name, attributes),
    );
  }

  update(update: TelemetryObservationUpdate): void {
    this.observation.updateOtelSpanAttributes(update);
  }
}

class ProviderRuntime implements TelemetryRuntime {
  private readonly counters = new Map<string, Counter>();
  private readonly histograms = new Map<string, Histogram>();
  private mode: TelemetryMode = "unknown";

  constructor(
    private readonly tracerProvider: BasicTracerProvider | null,
    private readonly loggerProvider: LoggerProvider | null,
    private readonly meterProvider: MeterProvider | null,
    private readonly meter: Meter | null,
    private readonly logger: Logger | null,
    private readonly sentry: SentryModule | null,
  ) {}

  captureError(error: unknown, context: string): void {
    this.sentry?.captureException(error, {
      tags: { context, mode: this.mode },
    });
    this.emitLog("yukino.error", "error", {
      context,
      "error.type": error instanceof Error ? error.name : typeof error,
    });
  }

  emitLog(
    name: string,
    severity: "error" | "info" | "warn",
    attributes: TelemetryAttributes = {},
  ): void {
    this.logger?.emit({
      attributes: { ...attributes, "yukino.mode": this.mode },
      body: name,
      severityNumber: severityNumber(severity),
      severityText: severity.toUpperCase(),
    });
  }

  async flush(): Promise<void> {
    const operations: Promise<unknown>[] = [];
    if (this.tracerProvider) {
      operations.push(this.tracerProvider.forceFlush());
    }
    if (this.loggerProvider) {
      operations.push(this.loggerProvider.forceFlush());
    }
    if (this.meterProvider) {
      operations.push(this.meterProvider.forceFlush());
    }
    if (this.sentry) {
      operations.push(this.sentry.flush(SHUTDOWN_TIMEOUT_MS));
    }
    await withTimeout(Promise.allSettled(operations).then(() => undefined));
  }

  recordMetric(
    name: string,
    kind: TelemetryMetricKind,
    value: number,
    attributes: TelemetryAttributes = {},
  ): void {
    if (!this.meter) {
      return;
    }
    const mergedAttributes = { ...attributes, "yukino.mode": this.mode };
    if (kind === "counter") {
      let counter = this.counters.get(name);
      if (!counter) {
        counter = this.meter.createCounter(name);
        this.counters.set(name, counter);
      }
      counter.add(value, mergedAttributes);
      return;
    }

    let histogram = this.histograms.get(name);
    if (!histogram) {
      histogram = this.meter.createHistogram(name, { unit: "ms" });
      this.histograms.set(name, histogram);
    }
    histogram.record(value, mergedAttributes);
  }

  setMode(mode: TelemetryMode): void {
    this.mode = mode;
    this.sentry?.setTag("yukino.mode", mode);
  }

  async shutdown(): Promise<void> {
    const operations: Promise<unknown>[] = [];
    if (this.tracerProvider) {
      operations.push(this.tracerProvider.shutdown());
    }
    if (this.loggerProvider) {
      operations.push(this.loggerProvider.shutdown());
    }
    if (this.meterProvider) {
      operations.push(this.meterProvider.shutdown());
    }
    if (this.sentry) {
      operations.push(this.sentry.close(SHUTDOWN_TIMEOUT_MS));
    }
    await withTimeout(Promise.allSettled(operations).then(() => undefined));
    setLangfuseTracerProvider(null);
  }

  startObservation(
    kind: TelemetryObservationKind,
    name: string,
    attributes: TelemetryAttributes = {},
  ): TelemetryObservation {
    if (!this.tracerProvider) {
      return {
        end: () => undefined,
        recordException: () => undefined,
        startChild: (childKind, childName, childAttributes) =>
          this.startObservation(childKind, childName, childAttributes),
        update: () => undefined,
      };
    }
    return new ProviderObservation(
      createRootObservation(kind, name, {
        ...attributes,
        "yukino.mode": this.mode,
      }),
    );
  }
}

export async function createTelemetryRuntime(): Promise<TelemetryRuntime> {
  const resource = createResource();
  const otelEnabled = process.env.OTEL_SDK_DISABLED?.toLowerCase() !== "true";

  const [tracerProvider, loggerProvider, metricReaders, sentry] =
    await Promise.all([
      otelEnabled
        ? safely(() => createTracerProvider(resource))
        : Promise.resolve(null),
      otelEnabled
        ? safely(() => createLoggerProvider(resource))
        : Promise.resolve(null),
      otelEnabled ? safely(createMetricReaders) : Promise.resolve(null),
      safely(initializeSentry),
    ]);

  const meterProvider =
    metricReaders && metricReaders.length > 0
      ? new MeterProvider({ readers: metricReaders, resource })
      : null;
  const meter = meterProvider?.getMeter("@yukino.js/yukino", version) ?? null;
  const logger =
    loggerProvider?.getLogger("@yukino.js/yukino", version) ?? null;

  return new ProviderRuntime(
    tracerProvider,
    loggerProvider,
    meterProvider,
    meter,
    logger,
    sentry,
  );
}

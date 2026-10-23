export const DEFAULT_EXPORT_INTERVAL_MS = 60_000;
export const SHUTDOWN_TIMEOUT_MS = 2_000;

/** Default OTLP resource service.name. */
export const SERVICE_NAME = "yukino";
/** Scope name for the OTel meter and logger. */
export const INSTRUMENTATION_SCOPE_NAME = "@yukino.js/yukino";

/** Exporter tokens accepted in OTEL_{TRACES,LOGS,METRICS}_EXPORTER. */
export const EXPORTER_NONE = "none";
export const EXPORTER_CONSOLE = "console";
export const EXPORTER_OTLP = "otlp";
export const EXPORTER_PROMETHEUS = "prometheus";

export const OTLP_PROTOCOL_GRPC = "grpc";
export const OTLP_PROTOCOL_HTTP_JSON = "http/json";
export const OTLP_PROTOCOL_HTTP_PROTOBUF = "http/protobuf";
export const DEFAULT_OTLP_PROTOCOL = OTLP_PROTOCOL_HTTP_PROTOBUF;

export const OBSERVATION_KIND_AGENT = "agent";
export const OBSERVATION_KIND_GENERATION = "generation";
export const OBSERVATION_KIND_TOOL = "tool";

export const OBSERVATION_LEVEL_DEFAULT = "DEFAULT";
export const OBSERVATION_LEVEL_ERROR = "ERROR";

/** OTel attribute keys shared by instrumentation and providers. */
export const ATTRIBUTE_ERROR_TYPE = "error.type";
export const ATTRIBUTE_MODE = "yukino.mode";
export const ATTRIBUTE_SESSION_HASH = "session.hash";
export const ATTRIBUTE_TOKEN_TYPE = "token.type";

export const METRIC_AGENT_RUNS = "yukino.agent.runs";
export const METRIC_AGENT_DURATION = "yukino.agent.duration";
export const METRIC_LLM_REQUESTS = "yukino.llm.requests";
export const METRIC_LLM_TOKENS = "yukino.llm.tokens";
export const METRIC_LLM_TIME_TO_FIRST_TOKEN = "yukino.llm.time_to_first_token";
export const METRIC_LLM_DURATION = "yukino.llm.duration";
export const METRIC_TOOL_CALLS = "yukino.tool.calls";
export const METRIC_TOOL_DURATION = "yukino.tool.duration";

export const OBSERVATION_AGENT_RUN = "yukino.agent.run";
export const OBSERVATION_LLM_GENERATE = "yukino.llm.generate";
export const OBSERVATION_TOOL_EXECUTE = "yukino.tool.execute";

export const LOG_ERROR = "yukino.error";
export const LOG_LLM_ERROR = "yukino.llm.error";
export const LOG_TOOL_ERROR = "yukino.tool.error";

export const HISTOGRAM_UNIT = "ms";
/** Sentry tracing stays off; OTel owns trace export. */
export const SENTRY_TRACES_SAMPLE_RATE = 0;

export const TOOL_ERROR_STATUS_MESSAGE = "Tool returned an error";

/** Replaces sensitive values scrubbed from payloads before export. */
export const REDACTED_PLACEHOLDER = "[redacted]";
/** Key names whose values are replaced wholesale before export. */
export const SENSITIVE_KEY_PATTERN =
  /(?:authorization|api[_-]?key|password|secret|credential|(?:^|[_-])token(?:$|[_-])|access[_-]?token|refresh[_-]?token|private[_-]?key|(?:^|[_-])dsn(?:$|[_-])|^(?:cookie|set-cookie)$)/iu;

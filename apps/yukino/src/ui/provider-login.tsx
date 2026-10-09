import { Box, Text, useInput, usePaste } from "ink";
import type { DOMElement } from "ink";
import { useCallback, useEffect, useRef, useState } from "react";

import { CursorText } from "./cursor-text.js";
import { SelectorFrame } from "./selector-frame.js";
import {
  cursorWindow,
  nextGraphemeBoundary,
  previousGraphemeBoundary,
  truncateToWidth,
} from "./terminal-text.js";
import { useTerminalDimensions } from "./use-terminal-layout.js";

import {
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_OUTPUT_TOKENS,
  DEFAULT_THINKING_LEVEL,
  getSupportedThinkingLevels,
  getThinkingLevel,
  type ProviderConfig,
  type ThinkingLevel,
} from "@/config/provider-config.js";
import { ProviderLoginSchema } from "@/config/provider-login.js";
import {
  discoverModels,
  modelListUrl,
  type DiscoveredModel,
} from "@/llm/model-discovery.js";
import { THEME } from "@/ui/styles.js";

const PROTOCOLS = ["anthropic", "openai", "openai-compat"] as const;
const FIELD_KEYS = [
  "name",
  "protocol",
  "base_url",
  "api_key",
  "model",
  "thinking",
  "context_window",
  "max_output_tokens",
] as const;

type FieldKey = (typeof FIELD_KEYS)[number];

interface FormState {
  name: string;
  protocol: ProviderConfig["protocol"];
  base_url: string;
  api_key: string;
  model: string;
  thinking: ThinkingLevel;
  context_window: string;
  max_output_tokens: string;
}

type FieldErrors = Record<string, string | undefined>;

interface ModelDiscoveryState {
  status: "idle" | "loading" | "ready" | "empty" | "error";
  models: DiscoveredModel[];
}

export interface ProviderLoginProps {
  initialValues?: Partial<ProviderConfig>;
  onSubmit: (provider: ProviderConfig) => Promise<void> | void;
  onCancel: () => void;
}

const FIELD_LABELS: Record<FieldKey, string> = {
  name: "Name",
  protocol: "Protocol",
  base_url: "Base URL",
  api_key: "API key",
  model: "Model",
  thinking: "Thinking",
  context_window: "Context window",
  max_output_tokens: "Max output tokens",
};

function normalizeThinkingLevel(
  value: ProviderConfig["thinking"],
): ThinkingLevel {
  return value ?? DEFAULT_THINKING_LEVEL;
}

function createInitialForm(initialValues?: Partial<ProviderConfig>): FormState {
  return {
    name: initialValues?.name ?? "",
    protocol: initialValues?.protocol ?? "anthropic",
    base_url: initialValues?.base_url ?? "",
    api_key: initialValues?.api_key ?? "",
    model: initialValues?.model ?? "",
    thinking: normalizeThinkingLevel(initialValues?.thinking),
    context_window: String(
      initialValues?.context_window ?? DEFAULT_CONTEXT_WINDOW,
    ),
    max_output_tokens: String(
      initialValues?.max_output_tokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
    ),
  };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  if (typeof error === "string" && error) {
    return error;
  }
  return "Unable to save provider";
}

function validateForm(
  form: FormState,
  initialValues?: Partial<ProviderConfig>,
): {
  provider?: ProviderConfig;
  errors: FieldErrors;
  formError?: string;
} {
  const errors: FieldErrors = {};
  const parsed = ProviderLoginSchema.safeParse({ ...initialValues, ...form });

  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const path = issue.path[0];
      if (
        typeof path === "string" &&
        FIELD_KEYS.some((key) => key === path) &&
        !errors[path]
      ) {
        errors[path] = issue.message;
      }
    }
  }

  if (Object.keys(errors).length > 0) {
    return { errors };
  }
  if (!parsed.success) {
    return {
      errors,
      formError: parsed.error.issues.map((issue) => issue.message).join("; "),
    };
  }
  return { provider: parsed.data, errors };
}

function displayValue(form: FormState, field: FieldKey): string {
  if (field === "protocol") {
    return form.protocol;
  }
  if (field === "thinking") {
    return form.thinking;
  }
  if (field === "api_key") {
    return form.api_key ? "•".repeat(form.api_key.length) : "";
  }
  return form[field];
}

function cursorValue(value: string, cursor: number, maxWidth: number) {
  const window = cursorWindow(value, cursor, maxWidth);
  return (
    <CursorText
      before={`${window.leadingEllipsis ? "…" : ""}${window.before}`}
      current={window.current}
      after={`${window.after}${window.trailingEllipsis ? "…" : ""}`}
      color={THEME.text}
    />
  );
}

export function ProviderLogin({
  initialValues,
  onSubmit,
  onCancel,
}: ProviderLoginProps) {
  const { columns } = useTerminalDimensions();
  const [form, setForm] = useState<FormState>(() =>
    createInitialForm(initialValues),
  );
  const [field, setField] = useState<FieldKey>("name");
  const [cursor, setCursor] = useState(0);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const focusRef = useRef<DOMElement>(null);
  const [discovery, setDiscovery] = useState<ModelDiscoveryState>({
    status: "idle",
    models: [],
  });
  const formRef = useRef(form);
  const fieldRef = useRef<FieldKey>(field);
  const cursorRef = useRef(cursor);
  const submittingRef = useRef(false);
  const discoveryGeneration = useRef(0);
  const discoveryController = useRef<AbortController | undefined>(undefined);
  const modelEditVersion = useRef(0);
  const completedConnection = useRef<
    Pick<FormState, "protocol" | "base_url" | "api_key"> | undefined
  >(undefined);

  formRef.current = form;
  fieldRef.current = field;
  cursorRef.current = cursor;

  const resetDiscovery = useCallback(() => {
    discoveryGeneration.current += 1;
    discoveryController.current?.abort();
    completedConnection.current = undefined;
    setDiscovery({ status: "idle", models: [] });
  }, []);

  const editingConnection = field === "base_url" || field === "api_key";

  useEffect(() => {
    const completed = completedConnection.current;
    if (
      completed?.protocol === form.protocol &&
      completed.base_url === form.base_url &&
      completed.api_key === form.api_key
    ) {
      return;
    }
    resetDiscovery();
    // Do not send a prefilled credential to a partially edited URL.
    if (editingConnection || !modelListUrl(form.protocol, form.base_url)) {
      return;
    }
    const config = {
      protocol: form.protocol,
      base_url: form.base_url,
      api_key: form.api_key,
    };
    const generation = discoveryGeneration.current;
    const controller = new AbortController();
    discoveryController.current = controller;
    const isCurrent = () =>
      !controller.signal.aborted && generation === discoveryGeneration.current;
    const timer = setTimeout(() => {
      if (!isCurrent()) {
        return;
      }
      const editVersion = modelEditVersion.current;
      setDiscovery({ status: "loading", models: [] });
      void discoverModels(config, controller.signal)
        .then((models) => {
          if (!isCurrent()) {
            return;
          }
          completedConnection.current = config;
          setDiscovery({ status: models.length ? "ready" : "empty", models });
          const first = models[0];
          if (
            first &&
            !formRef.current.model &&
            editVersion === 0 &&
            modelEditVersion.current === 0 &&
            !submittingRef.current
          ) {
            const nextForm = { ...formRef.current, model: first.id };
            formRef.current = nextForm;
            setForm(nextForm);
            setFieldErrors((current) => ({ ...current, model: undefined }));
            if (fieldRef.current === "model") {
              setCursor(first.id.length);
              cursorRef.current = first.id.length;
            }
          }
        })
        .catch(() => {
          if (isCurrent()) {
            completedConnection.current = config;
            setDiscovery({ status: "error", models: [] });
          }
        });
    }, 400);
    return () => {
      clearTimeout(timer);
      controller.abort();
      discoveryGeneration.current += 1;
    };
  }, [
    form.protocol,
    form.base_url,
    form.api_key,
    editingConnection,
    resetDiscovery,
  ]);

  const updateText = (value: string, nextCursor = value.length) => {
    const activeField = fieldRef.current;
    if (activeField === "protocol" || activeField === "thinking") {
      return;
    }
    if (
      (activeField === "base_url" || activeField === "api_key") &&
      value !== formRef.current[activeField]
    ) {
      resetDiscovery();
    } else if (activeField === "model") {
      modelEditVersion.current += 1;
    }
    setForm((current) => ({ ...current, [activeField]: value }));
    formRef.current = { ...formRef.current, [activeField]: value };
    setCursor(nextCursor);
    cursorRef.current = nextCursor;
    setFieldErrors((current) => ({ ...current, [activeField]: undefined }));
    setFormError("");
  };

  const insertText = (text: string) => {
    if (!text || submittingRef.current) {
      return;
    }
    const activeField = fieldRef.current;
    if (activeField === "protocol" || activeField === "thinking") {
      return;
    }
    const value = formRef.current[activeField];
    const position = Math.min(cursorRef.current, value.length);
    const inserted = text.replace(/\r\n?/g, "\n").replace(/\n/g, "");
    updateText(
      value.slice(0, position) + inserted + value.slice(position),
      position + inserted.length,
    );
  };

  const submit = async () => {
    if (submittingRef.current) {
      return;
    }
    const result = validateForm(formRef.current, initialValues);
    setFieldErrors(result.errors);
    setFormError(result.formError ?? "");
    if (!result.provider) {
      return;
    }

    submittingRef.current = true;
    setSubmitting(true);
    try {
      await onSubmit(result.provider);
    } catch (error) {
      setFormError(errorMessage(error));
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  const thinkingProvider = (): ProviderConfig => ({
    ...initialValues,
    ...formRef.current,
    context_window: Number(formRef.current.context_window),
    max_output_tokens: Number(formRef.current.max_output_tokens),
  });

  const moveField = (delta: number) => {
    const index = FIELD_KEYS.indexOf(fieldRef.current);
    const next = (index + delta + FIELD_KEYS.length) % FIELD_KEYS.length;
    const nextField = FIELD_KEYS[next] ?? FIELD_KEYS[0];
    setField(nextField);
    fieldRef.current = nextField;
    const nextCursor =
      nextField === "protocol" || nextField === "thinking"
        ? 0
        : formRef.current[nextField].length;
    setCursor(nextCursor);
    cursorRef.current = nextCursor;
  };

  usePaste(
    (text) => {
      insertText(text);
    },
    { isActive: !submitting },
  );

  useInput((input, key) => {
    if (submittingRef.current) {
      return;
    }
    if (/\[<\d+;\d+;\d+[Mm]/u.test(input)) {
      return;
    }
    if (key.escape || input === "\x1b") {
      onCancel();
      return;
    }
    if (key.tab) {
      moveField(key.shift ? -1 : 1);
      return;
    }
    if (key.upArrow) {
      moveField(-1);
      return;
    }
    if (key.downArrow) {
      moveField(1);
      return;
    }
    if (key.return || input === "\r" || input === "\n") {
      void submit();
      return;
    }

    const activeField = fieldRef.current;
    if (activeField === "protocol") {
      if (key.leftArrow || key.rightArrow) {
        const index = PROTOCOLS.indexOf(formRef.current.protocol);
        const next =
          (index + (key.rightArrow ? 1 : -1) + PROTOCOLS.length) %
          PROTOCOLS.length;
        const protocol = PROTOCOLS[next] ?? PROTOCOLS[0];
        const nextForm = { ...formRef.current, protocol };
        resetDiscovery();
        formRef.current = nextForm;
        setForm(nextForm);
        setFieldErrors((current) => ({ ...current, protocol: undefined }));
        setFormError("");
      }
      return;
    }
    if (activeField === "thinking") {
      if (key.leftArrow || key.rightArrow) {
        const provider = thinkingProvider();
        const levels = getSupportedThinkingLevels(provider);
        const index = levels.indexOf(getThinkingLevel(provider));
        const next =
          (index + (key.rightArrow ? 1 : -1) + levels.length) % levels.length;
        const thinking = levels[next] ?? "off";
        const nextForm = { ...formRef.current, thinking };
        formRef.current = nextForm;
        setForm(nextForm);
        setFieldErrors((current) => ({ ...current, thinking: undefined }));
        setFormError("");
      }
      return;
    }

    const value = formRef.current[activeField];
    const position = Math.min(cursorRef.current, value.length);
    if (
      activeField === "model" &&
      discovery.models.length > 0 &&
      !key.ctrl &&
      !key.meta &&
      (key.leftArrow || key.rightArrow)
    ) {
      const index = discovery.models.findIndex((model) => model.id === value);
      const next =
        index < 0
          ? key.rightArrow
            ? 0
            : discovery.models.length - 1
          : (index + (key.rightArrow ? 1 : -1) + discovery.models.length) %
            discovery.models.length;
      const model = discovery.models[next];
      if (model) {
        updateText(model.id);
      }
    } else if (key.ctrl && input === "u") {
      updateText("", 0);
    } else if (key.leftArrow || (key.ctrl && input === "b")) {
      const next = previousGraphemeBoundary(value, position);
      setCursor(next);
      cursorRef.current = next;
    } else if (key.rightArrow || (key.ctrl && input === "f")) {
      const next = nextGraphemeBoundary(value, position);
      setCursor(next);
      cursorRef.current = next;
    } else if (key.home || (key.ctrl && input === "a")) {
      setCursor(0);
      cursorRef.current = 0;
    } else if (key.end || (key.ctrl && input === "e")) {
      setCursor(value.length);
      cursorRef.current = value.length;
    } else if (key.backspace || key.delete) {
      if (key.backspace && position > 0) {
        const previous = previousGraphemeBoundary(value, position);
        updateText(value.slice(0, previous) + value.slice(position), previous);
      } else if (key.delete && position < value.length) {
        const next = nextGraphemeBoundary(value, position);
        updateText(value.slice(0, position) + value.slice(next), position);
      }
    } else if (input && !key.ctrl && !key.meta) {
      insertText(input);
    }
  });

  const frameWidth = Math.max(1, columns || 80);
  const framePadding = frameWidth > 2 ? 2 : 0;
  const contentWidth = Math.max(1, frameWidth - framePadding);
  const labelWidth = Math.max(1, Math.min(24, Math.floor(contentWidth * 0.36)));
  const valueWidth = Math.max(
    1,
    contentWidth - labelWidth - (contentWidth > labelWidth ? 1 : 0),
  );
  const discoveryHelp: Record<ModelDiscoveryState["status"], string> = {
    idle: editingConnection
      ? "Tab to finish connection and fetch models"
      : "Models: waiting for a valid URL",
    loading: "Fetching models…",
    ready: `${String(discovery.models.length)} models available · ←→ cycle`,
    empty: "No models returned",
    error: "Model discovery unavailable",
  };

  return (
    <SelectorFrame
      focusRef={focusRef}
      hint="↑↓/Tab field · ←→ choose in protocol/thinking/model-list fields · Enter submit · Esc cancel"
      subtitle={
        submitting
          ? "Saving provider…"
          : formError || "Add a provider connection"
      }
      title="Provider login"
      width={frameWidth}
    >
      <Box flexDirection="column" width="100%">
        {FIELD_KEYS.map((key) => {
          const selected = key === field;
          const rawValue =
            key === "thinking"
              ? getThinkingLevel(thinkingProvider())
              : displayValue(form, key);
          const value =
            key === "protocol" && selected
              ? `‹ ${rawValue} ›`
              : key === "thinking" && selected
                ? `‹ ${rawValue} ›`
                : selected && key !== "protocol" && key !== "thinking"
                  ? cursorValue(rawValue, cursor, valueWidth)
                  : truncateToWidth(rawValue || "(empty)", valueWidth);
          return (
            <Box
              key={key}
              ref={selected ? focusRef : undefined}
              flexDirection="column"
              width="100%"
            >
              <Box
                backgroundColor={selected ? THEME.selectedBg : undefined}
                paddingRight={contentWidth > labelWidth ? 1 : 0}
                width="100%"
              >
                <Box flexShrink={0} width={labelWidth}>
                  <Text
                    color={selected ? THEME.accent : THEME.muted}
                    wrap="truncate-end"
                  >
                    {truncateToWidth(
                      `${selected ? "›" : " "} ${FIELD_LABELS[key]}:`,
                      labelWidth,
                    )}
                  </Text>
                </Box>
                {selected && key !== "protocol" && key !== "thinking" ? (
                  value
                ) : (
                  <Text
                    color={selected ? THEME.text : THEME.muted}
                    wrap="truncate-end"
                  >
                    {value}
                  </Text>
                )}
              </Box>
              {fieldErrors[key] ? (
                <Text color={THEME.error} wrap="truncate-end">
                  {truncateToWidth(`  ${fieldErrors[key]}`, contentWidth)}
                </Text>
              ) : null}
            </Box>
          );
        })}
        <Text color={THEME.muted} wrap="truncate-end">
          {discoveryHelp[discovery.status]}
        </Text>
        <Text color={THEME.dim} wrap="truncate-end">
          type/paste any ID · Ctrl+U clear
        </Text>
        <Text color={THEME.dim} wrap="truncate-end">
          Home/End · Ctrl+B/F move cursor
        </Text>
      </Box>
    </SelectorFrame>
  );
}

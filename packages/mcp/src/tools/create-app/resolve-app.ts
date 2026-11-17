import { z } from "zod";

const NonEmptyString = z.string().min(1);

// 类型不对或空字符串都视为缺失，避免一个坏字段拖垮整份结果。
const OptionalNonEmptyString = NonEmptyString.optional().catch(undefined);

const EmptyPayload = { html: undefined, title: undefined };

function asPayload(value: unknown): object {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value;
  }
  return {};
}

const AppPayload = z
  .object({
    html: OptionalNonEmptyString,
    title: OptionalNonEmptyString,
  })
  .catch(EmptyPayload);

const ResolveInput = z.object({
  resultMeta: AppPayload,
  structuredContent: AppPayload,
  inputHtml: OptionalNonEmptyString,
  inputTitle: OptionalNonEmptyString,
  fallbackTitle: z.string(),
});

export const AppDocumentSchema = z.object({
  html: NonEmptyString,
  title: z.string(),
});

export type AppDocument = z.infer<typeof AppDocumentSchema>;

// 宿主可能丢掉工具结果里的 _meta。HTML 依次取自结果 _meta、structuredContent，
// 最后回退到已经送达的 tool-input 参数。
export function resolveAppDocument(input: {
  resultMeta?: unknown;
  structuredContent?: unknown;
  inputHtml?: string;
  inputTitle?: string;
  fallbackTitle: string;
}): AppDocument | undefined {
  const parsed = ResolveInput.parse({
    resultMeta: asPayload(input.resultMeta),
    structuredContent: asPayload(input.structuredContent),
    inputHtml: input.inputHtml,
    inputTitle: input.inputTitle,
    fallbackTitle: input.fallbackTitle,
  });
  const html =
    parsed.resultMeta.html ?? parsed.structuredContent.html ?? parsed.inputHtml;
  if (html === undefined) {
    return undefined;
  }
  return AppDocumentSchema.parse({
    html,
    title:
      parsed.resultMeta.title ??
      parsed.structuredContent.title ??
      parsed.inputTitle ??
      parsed.fallbackTitle,
  });
}

import { z } from "zod";

export const CodeReviewFormSchema = z
  .object({
    focus: z.string(),
    from: z.string(),
    to: z.string(),
    commit: z.string(),
    exclude: z.string(),
  })
  .superRefine((values, context) => {
    const from = values.from.trim();
    const to = values.to.trim();
    const commit = values.commit.trim();

    if (from && !to) {
      context.addIssue({
        code: "custom",
        path: ["to"],
        message: "To is required when From is set",
      });
    }
    if (to && !from) {
      context.addIssue({
        code: "custom",
        path: ["from"],
        message: "From is required when To is set",
      });
    }
    if (commit && (from || to)) {
      context.addIssue({
        code: "custom",
        path: ["commit"],
        message: "Commit cannot be combined with From/To",
      });
    }
    const validateRef = (
      field: "from" | "to" | "commit",
      value: string,
    ): void => {
      if (/\r|\n/u.test(value)) {
        context.addIssue({
          code: "custom",
          path: [field],
          message: "Git refs must be a single line",
        });
      } else if (value.startsWith("-")) {
        context.addIssue({
          code: "custom",
          path: [field],
          message: "Git refs must not start with '-'",
        });
      }
    };
    validateRef("from", from);
    validateRef("to", to);
    validateRef("commit", commit);
  })
  .transform((values) => {
    const from = values.from.trim();
    const to = values.to.trim();
    const commit = values.commit.trim();
    return {
      background: values.focus.trim(),
      from: from || undefined,
      to: to || undefined,
      commit: commit || undefined,
      excludePatterns: values.exclude
        .split(/[;\n]/u)
        .map((pattern) => pattern.trim())
        .filter(Boolean),
    };
  });

export type CodeReviewFormValues = z.input<typeof CodeReviewFormSchema>;
export type CodeReviewFormOptions = z.output<typeof CodeReviewFormSchema>;

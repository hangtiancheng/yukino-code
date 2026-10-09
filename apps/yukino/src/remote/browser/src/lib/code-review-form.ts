import type { CodeReviewStartPayload } from "@browser/types";

/**
 * Browser port of the terminal CodeReviewFormSchema (src/code-review/form.ts):
 * same field rules, implemented without zod. Unlike the terminal transform,
 * empty fields become `undefined` instead of `""`; the server normalizes
 * both. The server re-validates refs on receipt (validateReviewInput +
 * newline check).
 */

export type CodeReviewField = "focus" | "from" | "to" | "commit" | "exclude";

export type CodeReviewFormValues = Record<CodeReviewField, string>;

export type CodeReviewFieldErrors = Partial<Record<CodeReviewField, string>>;

export const EMPTY_CODE_REVIEW_FORM: CodeReviewFormValues = {
  focus: "",
  from: "",
  to: "",
  commit: "",
  exclude: "",
};

export interface CodeReviewValidation {
  errors: CodeReviewFieldErrors;
  /** Present only when there are no errors. */
  options?: CodeReviewStartPayload;
}

export function validateCodeReviewForm(
  values: CodeReviewFormValues,
): CodeReviewValidation {
  const errors: CodeReviewFieldErrors = {};
  const from = values.from.trim();
  const to = values.to.trim();
  const commit = values.commit.trim();

  if (from && !to) {
    errors.to = "To is required when From is set";
  }
  if (to && !from) {
    errors.from = "From is required when To is set";
  }
  if (commit && (from || to)) {
    errors.commit = "Commit cannot be combined with From/To";
  }

  const checkRef = (field: "from" | "to" | "commit", value: string): void => {
    if (errors[field]) {
      return;
    }
    if (/[\r\n]/u.test(value)) {
      errors[field] = "Git refs must be a single line";
    } else if (value.startsWith("-")) {
      errors[field] = "Git refs must not start with '-'";
    }
  };
  checkRef("from", from);
  checkRef("to", to);
  checkRef("commit", commit);

  if (Object.keys(errors).length > 0) {
    return { errors };
  }

  return {
    errors,
    options: {
      background: values.focus.trim() || undefined,
      from: from || undefined,
      to: to || undefined,
      commit: commit || undefined,
      excludePatterns: values.exclude
        .split(/[;\n]/u)
        .map((pattern) => pattern.trim())
        .filter(Boolean),
    },
  };
}

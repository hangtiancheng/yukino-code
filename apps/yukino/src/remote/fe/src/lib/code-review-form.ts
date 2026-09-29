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

import type { CodeReviewStartPayload } from "@fe/types";

/**
 * Browser port of the terminal CodeReviewFormSchema (src/code-review/form.ts):
 * same field rules and the same transform into CodeReviewFormOptions, without
 * pulling zod into the browser bundle. The server re-validates on receipt.
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

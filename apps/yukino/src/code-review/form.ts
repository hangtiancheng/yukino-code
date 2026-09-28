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

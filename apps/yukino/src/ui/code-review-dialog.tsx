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

import { Box, Text, useInput } from "ink";
import { useRef, useState } from "react";

import { SelectorFrame } from "./selector-frame.js";
import { TextField } from "./text-field.js";

import {
  CodeReviewFormSchema,
  type CodeReviewFormOptions,
  type CodeReviewFormValues,
} from "@/code-review/form.js";
import { THEME } from "@/ui/styles.js";

export interface CodeReviewDialogProps {
  onSubmit: (options: CodeReviewFormOptions) => Promise<void> | void;
  onCancel: () => void;
}

type FieldKey = keyof CodeReviewFormValues;
type FieldErrors = Partial<Record<FieldKey, string>>;

const FIELD_KEYS: FieldKey[] = ["focus", "from", "to", "commit", "exclude"];
const FIELD_LABELS: Record<FieldKey, string> = {
  focus: "Focus",
  from: "From",
  to: "To",
  commit: "Commit",
  exclude: "Exclude globs",
};

const EMPTY_FORM: CodeReviewFormValues = {
  focus: "",
  from: "",
  to: "",
  commit: "",
  exclude: "",
};

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  if (typeof error === "string" && error) {
    return error;
  }
  return "Unable to start code review";
}

function displayValue(value: string): string {
  return value ? value.replace(/\r?\n/gu, "; ") : "(empty)";
}

export function CodeReviewDialog({
  onSubmit,
  onCancel,
}: CodeReviewDialogProps) {
  const [form, setForm] = useState<CodeReviewFormValues>(EMPTY_FORM);
  const [field, setField] = useState<FieldKey>("focus");
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const formRef = useRef(form);
  const fieldRef = useRef(field);
  const submittingRef = useRef(false);

  formRef.current = form;
  fieldRef.current = field;

  const updateField = (key: FieldKey, value: string): void => {
    const next = { ...formRef.current, [key]: value };
    formRef.current = next;
    setForm(next);
    setFieldErrors((current) => ({ ...current, [key]: undefined }));
    setFormError("");
  };

  const moveField = (delta: number): void => {
    const index = FIELD_KEYS.indexOf(fieldRef.current);
    const next = (index + delta + FIELD_KEYS.length) % FIELD_KEYS.length;
    const nextField = FIELD_KEYS[next] ?? FIELD_KEYS[0];
    setField(nextField);
    fieldRef.current = nextField;
  };

  const submit = async (activeValue: string): Promise<void> => {
    if (submittingRef.current) {
      return;
    }
    const values = { ...formRef.current, [fieldRef.current]: activeValue };
    formRef.current = values;
    setForm(values);
    const parsed = CodeReviewFormSchema.safeParse(values);
    if (!parsed.success) {
      const errors: FieldErrors = {};
      for (const issue of parsed.error.issues) {
        const path = issue.path[0];
        const errorField = FIELD_KEYS.find((key) => key === path);
        if (errorField && !errors[errorField]) {
          errors[errorField] = issue.message;
        }
      }
      setFieldErrors(errors);
      setFormError(
        Object.keys(errors).length === 0
          ? parsed.error.issues.map((issue) => issue.message).join("; ")
          : "",
      );
      return;
    }

    submittingRef.current = true;
    setSubmitting(true);
    try {
      await onSubmit(parsed.data);
    } catch (error) {
      setFormError(errorMessage(error));
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  useInput(
    (input, key) => {
      if (key.escape || input === "\x1b") {
        onCancel();
      } else if (key.tab || key.downArrow) {
        moveField(key.shift ? -1 : 1);
      } else if (key.upArrow) {
        moveField(-1);
      }
    },
    { isActive: !submitting },
  );

  return (
    <SelectorFrame
      hint="↑↓/Tab field · Shift+Enter newline · Enter run · Esc cancel"
      subtitle={
        submitting
          ? "Starting review…"
          : formError ||
            "No refs = uncommitted · From + To = range · Commit = one commit"
      }
      title="Code review"
    >
      <Box flexDirection="column" width="100%">
        {FIELD_KEYS.map((key) => {
          const selected = key === field;
          return (
            <Box key={key} flexDirection="column" width="100%">
              <Text color={selected ? THEME.accent : THEME.muted}>
                {selected ? "› " : "  "}
                {FIELD_LABELS[key]}
              </Text>
              {selected ? (
                <TextField
                  key={key}
                  initialValue={form[key]}
                  isActive={!submitting}
                  indent={2}
                  onChange={(value) => {
                    updateField(key, value);
                  }}
                  onSubmit={(value) => {
                    void submit(value);
                  }}
                />
              ) : (
                <Text color={THEME.dim} wrap="truncate-end">
                  {`  ${displayValue(form[key])}`}
                </Text>
              )}
              {fieldErrors[key] ? (
                <Text color={THEME.error} wrap="truncate-end">
                  {`  ${fieldErrors[key]}`}
                </Text>
              ) : null}
            </Box>
          );
        })}
        <Text color={THEME.dim}>
          Separate exclude globs with semicolons or new lines.
        </Text>
      </Box>
    </SelectorFrame>
  );
}

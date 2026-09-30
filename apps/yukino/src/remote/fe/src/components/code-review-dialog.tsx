import {
  EMPTY_CODE_REVIEW_FORM,
  validateCodeReviewForm,
  type CodeReviewFieldErrors,
  type CodeReviewFormValues,
} from "@fe/lib/code-review-form";
import type { CodeReviewStartPayload } from "@fe/types";
import { useState } from "react";

import { Modal, ModalHeader } from "./modal";

interface CodeReviewDialogProps {
  onRun: (options: CodeReviewStartPayload) => void;
  onClose: () => void;
}

interface FieldProps {
  label: string;
  value: string;
  error?: string;
  placeholder?: string;
  hint?: string;
  rows?: number;
  onChange: (value: string) => void;
}

function Field({
  label,
  value,
  error,
  placeholder,
  hint,
  rows,
  onChange,
}: FieldProps) {
  const shared =
    "w-full rounded-lg border bg-bg px-3 py-2 text-sm text-bright outline-none placeholder:text-dim/60 focus:border-accent";
  const border = error ? "border-red/50" : "border-border";
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-semibold text-base">
        {label}
      </span>
      {rows ? (
        <textarea
          value={value}
          onChange={(e) => {
            onChange(e.target.value);
          }}
          placeholder={placeholder}
          aria-label={label}
          rows={rows}
          className={`${shared} ${border} resize-none`}
        />
      ) : (
        <input
          type="text"
          value={value}
          onChange={(e) => {
            onChange(e.target.value);
          }}
          placeholder={placeholder}
          aria-label={label}
          className={`${shared} ${border}`}
        />
      )}
      {error ? (
        <span className="mt-1 block text-xs text-red">{error}</span>
      ) : hint ? (
        <span className="mt-1 block text-[11px] text-dim/70">{hint}</span>
      ) : null}
    </label>
  );
}

/** Code review configuration form (parity with the terminal dialog). */
export function CodeReviewDialog({ onRun, onClose }: CodeReviewDialogProps) {
  const [form, setForm] = useState<CodeReviewFormValues>(
    EMPTY_CODE_REVIEW_FORM,
  );
  const [errors, setErrors] = useState<CodeReviewFieldErrors>({});

  const update = (field: keyof CodeReviewFormValues, value: string): void => {
    setForm((current) => ({ ...current, [field]: value }));
    setErrors((current) =>
      current[field] ? { ...current, [field]: undefined } : current,
    );
  };

  const submit = (): void => {
    const result = validateCodeReviewForm(form);
    if (!result.options) {
      setErrors(result.errors);
      return;
    }
    onRun(result.options);
  };

  return (
    <Modal label="Code review" maxWidth="max-w-xl" onEscape={onClose}>
      <ModalHeader
        subtitle="No refs = uncommitted · From + To = range · Commit = one commit"
        title="Code review"
      />
      <div className="min-h-0 flex-1 space-y-3.5 overflow-y-auto px-5 py-4">
        <Field
          label="Focus"
          value={form.focus}
          error={errors.focus}
          placeholder="What should the review focus on? (optional)"
          rows={2}
          onChange={(value) => {
            update("focus", value);
          }}
        />
        <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-3">
          <Field
            label="From"
            value={form.from}
            error={errors.from}
            placeholder="main"
            onChange={(value) => {
              update("from", value);
            }}
          />
          <Field
            label="To"
            value={form.to}
            error={errors.to}
            placeholder="feature/auth"
            onChange={(value) => {
              update("to", value);
            }}
          />
          <Field
            label="Commit"
            value={form.commit}
            error={errors.commit}
            placeholder="abc1234"
            onChange={(value) => {
              update("commit", value);
            }}
          />
        </div>
        <Field
          label="Exclude globs"
          value={form.exclude}
          error={errors.exclude}
          placeholder={"**/*.pb.go\nfixtures/**"}
          hint="Separate exclude globs with semicolons or new lines."
          rows={2}
          onChange={(value) => {
            update("exclude", value);
          }}
        />
      </div>
      <div className="flex items-center justify-end gap-2 border-t border-border px-5 py-4">
        <button
          type="button"
          onClick={onClose}
          className="cursor-pointer rounded-lg border border-border px-4 py-1.5 text-[13px] font-semibold text-base transition-colors hover:bg-bg"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={submit}
          className="cursor-pointer rounded-lg bg-accent px-4 py-1.5 text-[13px] font-semibold text-white shadow-xs transition-colors hover:bg-accent-dim"
        >
          Run review
        </button>
      </div>
    </Modal>
  );
}

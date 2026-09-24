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

import type { AskUserItem, Question } from "@fe/types";
import { useState } from "react";

interface QuestionDraft {
  /** Selected option labels (at most one for single-select questions). */
  selected: string[];
  /** Free-text value for the automatic "Other" option. */
  other: string;
  /** Whether the "Other" free-text option is active. */
  useOther: boolean;
}

const emptyDraft = (): QuestionDraft => ({
  selected: [],
  other: "",
  useOther: false,
});

interface AskUserDialogProps {
  item: AskUserItem;
  onAnswer: (id: string, answers: Record<string, string>) => void;
}

export function AskUserDialog({ item, onAnswer }: AskUserDialogProps) {
  const [drafts, setDrafts] = useState<Record<string, QuestionDraft>>({});

  const getDraft = (key: string): QuestionDraft => drafts[key] ?? emptyDraft();

  const updateDraft = (key: string, patch: Partial<QuestionDraft>) => {
    setDrafts((prev) => ({
      ...prev,
      [key]: { ...(prev[key] ?? emptyDraft()), ...patch },
    }));
  };

  const handleSubmit = () => {
    const answers: Record<string, string> = {};
    item.questions.forEach((q, qi) => {
      const d = getDraft(`${item.id}_${String(qi)}`);
      answers[q.question] = buildAnswer(q, d);
    });
    onAnswer(item.id, answers);
  };

  if (item.answered) {
    return (
      <div className="my-3 rounded-xl border border-border bg-surface px-4 py-3 text-sm text-dim shadow-xs">
        <span className="mr-1.5 text-green">✓</span> Answered
      </div>
    );
  }

  return (
    <section
      aria-label="Question from the agent"
      className="my-3 rounded-xl border border-accent/30 bg-surface p-4 shadow-xs"
    >
      <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-bright">
        <span className="flex h-5 w-5 items-center justify-center rounded-full bg-accent/10 text-xs text-accent">
          ?
        </span>
        Question
      </div>
      {item.questions.map((q, qi) => {
        const key = `${item.id}_${String(qi)}`;
        return (
          <QuestionRow
            key={key}
            question={q}
            name={`ask_${item.id}_${String(qi)}`}
            draft={getDraft(key)}
            onChange={(patch) => {
              updateDraft(key, patch);
            }}
          />
        );
      })}
      <div className="mt-3 flex justify-end">
        <button
          type="button"
          onClick={handleSubmit}
          className="cursor-pointer rounded-lg bg-accent px-4 py-1.5 text-[13px] font-semibold text-white shadow-xs transition-colors hover:bg-accent-dim focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-dim"
        >
          Submit
        </button>
      </div>
    </section>
  );
}

/** Builds the answer string for a question draft.
 *  Multi-select joins labels with ", "; "Other" text is appended when active. */
function buildAnswer(question: Question, draft: QuestionDraft): string {
  const parts = [...draft.selected];
  if (draft.useOther && draft.other.trim() !== "") {
    parts.push(draft.other.trim());
  }
  if (question.multiSelect) {
    return parts.join(", ");
  }
  if (draft.useOther) {
    return draft.other;
  }
  return parts[0] ?? "";
}

interface QuestionRowProps {
  question: Question;
  name: string;
  draft: QuestionDraft;
  onChange: (patch: Partial<QuestionDraft>) => void;
}

function QuestionRow({ question, name, draft, onChange }: QuestionRowProps) {
  const toggleOption = (label: string) => {
    if (question.multiSelect) {
      const selected = draft.selected.includes(label)
        ? draft.selected.filter((l) => l !== label)
        : [...draft.selected, label];
      onChange({ selected, useOther: false });
    } else {
      onChange({ selected: [label], useOther: false });
    }
  };

  return (
    <fieldset className="mb-3">
      <legend className="mb-2 text-sm font-medium text-bright">
        {question.question || question.header}
        {question.multiSelect && (
          <span className="ml-2 text-xs text-dim">(select all that apply)</span>
        )}
      </legend>
      {question.options.map((opt) => {
        const checked = draft.selected.includes(opt.label);
        return (
          <label
            key={opt.label}
            className={`my-1 flex cursor-pointer items-start gap-2.5 rounded-lg border px-3 py-2 transition-colors ${
              checked
                ? "border-accent/40 bg-accent/6"
                : "border-transparent hover:border-border hover:bg-bg"
            }`}
          >
            <input
              type={question.multiSelect ? "checkbox" : "radio"}
              name={name}
              value={opt.label}
              checked={checked}
              onChange={() => {
                toggleOption(opt.label);
              }}
              className="mt-0.5 accent-accent"
            />
            <span className="min-w-0">
              <span className="text-sm text-bright">{opt.label}</span>
              {opt.description && (
                <span className="ml-2 text-xs text-dim">{opt.description}</span>
              )}
            </span>
          </label>
        );
      })}
      <label
        className={`my-1 flex cursor-pointer items-center gap-2.5 rounded-lg border px-3 py-2 transition-colors ${
          draft.useOther
            ? "border-accent/40 bg-accent/6"
            : "border-transparent hover:border-border hover:bg-bg"
        }`}
      >
        <input
          type={question.multiSelect ? "checkbox" : "radio"}
          name={name}
          value="__other__"
          checked={draft.useOther}
          onChange={() => {
            onChange({
              useOther: true,
              selected: question.multiSelect ? draft.selected : [],
            });
          }}
          className="accent-accent"
        />
        <span className="text-sm text-dim">Other:</span>
        <input
          type="text"
          value={draft.other}
          onFocus={() => {
            onChange({
              useOther: true,
              selected: question.multiSelect ? draft.selected : [],
            });
          }}
          onChange={(e) => {
            onChange({ other: e.target.value, useOther: true });
          }}
          placeholder="Type a custom answer..."
          className="min-w-0 flex-1 rounded-md border border-border bg-bg px-2 py-1 text-[13px] text-bright outline-none placeholder:text-dim/70 focus:border-accent"
        />
      </label>
    </fieldset>
  );
}

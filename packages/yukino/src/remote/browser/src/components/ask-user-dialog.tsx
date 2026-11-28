import { useState } from "react";

import { Button } from "#/components/ui/button.js";
import { Checkbox } from "#/components/ui/checkbox.js";
import { FieldSet, FieldLegend } from "#/components/ui/field.js";
import { Input } from "#/components/ui/input.js";
import { Label } from "#/components/ui/label.js";
import { RadioGroup, RadioGroupItem } from "#/components/ui/radio-group.js";
import type { AskUserItem, Question } from "#/types.js";

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
      <div className="my-3 rounded-xl border border-border bg-surface px-4 py-3 text-sm text-dim ">
        <span className="mr-1.5 text-success">✓</span> Answered
      </div>
    );
  }

  return (
    <section
      aria-label="Question from the agent"
      className="my-3 rounded-xl border border-accent/30 bg-accent-bg p-4 "
    >
      <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-bright">
        <span className="flex h-5 w-5 items-center justify-center rounded-full bg-accent-bg text-xs text-accent">
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
        <Button
          type="button"
          onClick={handleSubmit}
          className="cursor-pointer rounded-lg bg-accent px-4 py-1.5 text-[13px] font-semibold text-accent-contrast transition-colors hover:bg-accent-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          Submit
        </Button>
      </div>
    </section>
  );
}

/** Builds the answer string for a question draft. Multi-select joins the
 *  selected labels with ", " and appends the trimmed "Other" text when
 *  non-empty; single-select returns the raw "Other" text when that option is
 *  active, otherwise the sole selected label ("" when none). */
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

  const options = (
    <>
      {question.options.map((opt) => {
        const checked = draft.selected.includes(opt.label);
        return (
          <Label
            key={opt.label}
            className={`my-1 flex cursor-pointer items-start gap-2.5 rounded-lg border px-3 py-2 transition-colors ${checked ? "border-accent/40 bg-accent/6" : "border-transparent hover:border-border hover:bg-selected"}`}
          >
            {question.multiSelect ? (
              <Checkbox
                name={name}
                value={opt.label}
                checked={checked}
                onCheckedChange={() => {
                  toggleOption(opt.label);
                }}
                className="mt-0.5"
              />
            ) : (
              <RadioGroupItem value={opt.label} className="mt-0.5" />
            )}
            <span className="min-w-0">
              <span className="text-sm text-bright">{opt.label}</span>
              {opt.description && (
                <span className="ml-2 text-xs text-dim">{opt.description}</span>
              )}
            </span>
          </Label>
        );
      })}
      <Label
        className={`my-1 flex cursor-pointer items-center gap-2.5 rounded-lg border px-3 py-2 transition-colors ${draft.useOther ? "border-accent/40 bg-accent/6" : "border-transparent hover:border-border hover:bg-selected"}`}
      >
        {question.multiSelect ? (
          <Checkbox
            name={name}
            checked={draft.useOther}
            onCheckedChange={(checked) => {
              onChange({ useOther: checked });
            }}
          />
        ) : (
          <RadioGroupItem value="__other__" />
        )}
        <span className="text-sm text-dim">Other:</span>
        <Input
          type="text"
          value={draft.other}
          onFocus={() => {
            onChange({
              useOther: true,
              selected: question.multiSelect ? draft.selected : [],
            });
          }}
          onChange={(event) => {
            onChange({ other: event.target.value, useOther: true });
          }}
          placeholder="Type a custom answer..."
          className="min-w-0 flex-1 rounded-lg border border-border bg-bg px-2 py-1 text-[13px] text-bright outline-none placeholder:text-dim focus:border-accent"
        />
      </Label>
    </>
  );
  return (
    <FieldSet className="mb-3">
      <FieldLegend className="mb-2 text-sm font-medium text-bright">
        {question.question}
        {question.multiSelect && (
          <span className="ml-2 text-xs text-dim">(select all that apply)</span>
        )}
      </FieldLegend>
      {question.multiSelect ? (
        options
      ) : (
        <RadioGroup
          name={name}
          value={draft.useOther ? "__other__" : (draft.selected[0] ?? "")}
          onValueChange={(value) => {
            if (value === "__other__") {
              onChange({ useOther: true, selected: [] });
            } else if (typeof value === "string") {
              toggleOption(value);
            }
          }}
        >
          {options}
        </RadioGroup>
      )}
    </FieldSet>
  );
}

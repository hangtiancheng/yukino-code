// Inline AskUserQuestion card: each question's options render as a ToggleGroup
// (single or multiple select), plus an "Other" free-text field, and answers are
// submitted back through the bridge.

import { useMemo, useState } from "react";
import { CircleHelpIcon } from "lucide-react";
import type { ChatItem } from "@renderer/lib/chat-state";
import { Card, CardContent } from "@renderer/components/ui/card";
import { Button } from "@renderer/components/ui/button";
import { Badge } from "@renderer/components/ui/badge";
import { Separator } from "@renderer/components/ui/separator";
import { Input } from "@renderer/components/ui/input";
import { Label } from "@renderer/components/ui/label";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@renderer/components/ui/toggle-group";

type AskItem = Extract<ChatItem, { kind: "ask" }>;

const OTHER = "__other__";

interface QuestionDraft {
  selected: string[];
  otherText: string;
}

function answerFor(draft: QuestionDraft): string {
  const chosen = draft.selected.filter((label) => label !== OTHER);
  const parts: string[] = [...chosen];
  if (draft.selected.includes(OTHER) && draft.otherText.trim()) {
    parts.push(draft.otherText.trim());
  }
  return parts.join(", ");
}

export function AskCard({
  item,
  onRespond,
}: {
  item: AskItem;
  onRespond: (id: string, answers: Record<string, string>) => void;
}): React.JSX.Element {
  const [drafts, setDrafts] = useState<QuestionDraft[]>(() =>
    item.payload.questions.map(() => ({ selected: [], otherText: "" })),
  );

  const answers = useMemo(() => {
    const result: Record<string, string> = {};
    item.payload.questions.forEach((question, index) => {
      result[question.question] = answerFor(drafts[index]);
    });
    return result;
  }, [item.payload.questions, drafts]);

  const complete = item.payload.questions.every(
    (_, index) => answerFor(drafts[index]).trim() !== "",
  );

  const setSelected = (questionIndex: number, selected: string[]): void => {
    setDrafts((previous) =>
      previous.map((draft, index) =>
        index === questionIndex ? { ...draft, selected } : draft,
      ),
    );
  };

  const setOtherText = (questionIndex: number, otherText: string): void => {
    setDrafts((previous) =>
      previous.map((draft, index) =>
        index === questionIndex ? { ...draft, otherText } : draft,
      ),
    );
  };

  return (
    <Card className="w-full max-w-2xl gap-0 py-0">
      <CardContent className="flex flex-col gap-4 p-4">
        <div className="flex items-center gap-2">
          <span className="bg-muted text-muted-foreground flex size-7 shrink-0 items-center justify-center rounded-md">
            <CircleHelpIcon className="size-4" />
          </span>
          <span className="text-sm font-medium">Question</span>
          {item.answered ? (
            <Badge variant="secondary" className="text-[10px] uppercase">
              answered
            </Badge>
          ) : (
            <Badge variant="outline" className="text-[10px] uppercase">
              waiting
            </Badge>
          )}
        </div>

        {item.payload.questions.map((question, questionIndex) => {
          const draft = drafts[questionIndex];
          const last = questionIndex === item.payload.questions.length - 1;
          return (
            <div key={question.question} className="flex flex-col gap-3">
              <div className="flex flex-col gap-1">
                <p className="text-sm leading-relaxed font-medium">
                  {question.question}
                </p>
                {question.multiSelect ? (
                  <span className="text-muted-foreground text-xs">
                    Select all that apply
                  </span>
                ) : null}
              </div>

              <ToggleGroup
                multiple={question.multiSelect}
                orientation="vertical"
                className="w-full"
                value={draft.selected}
                onValueChange={(value) => setSelected(questionIndex, value)}
                disabled={item.answered}
              >
                {question.options.map((option) => (
                  <ToggleGroupItem
                    key={option.label}
                    value={option.label}
                    variant="outline"
                    className="w-full justify-start"
                  >
                    <span className="flex min-w-0 flex-col items-start gap-0.5 py-1 text-left">
                      <span className="text-sm font-medium">
                        {option.label}
                      </span>
                      {option.description ? (
                        <span className="text-muted-foreground text-xs leading-relaxed">
                          {option.description}
                        </span>
                      ) : null}
                    </span>
                  </ToggleGroupItem>
                ))}
                <ToggleGroupItem
                  value={OTHER}
                  variant="outline"
                  className="w-full justify-start"
                >
                  <span className="text-sm font-medium">Other…</span>
                </ToggleGroupItem>
              </ToggleGroup>

              {draft.selected.includes(OTHER) ? (
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor={`${item.id}-other`} className="sr-only">
                    Other answer
                  </Label>
                  <Input
                    id={`${item.id}-other`}
                    autoFocus
                    placeholder="Type a custom answer"
                    value={draft.otherText}
                    disabled={item.answered}
                    onChange={(event) =>
                      setOtherText(questionIndex, event.target.value)
                    }
                  />
                </div>
              ) : null}

              {!last ? <Separator /> : null}
            </div>
          );
        })}

        {!item.answered ? (
          <Button
            disabled={!complete}
            onClick={() => onRespond(item.payload.id, answers)}
          >
            Submit
          </Button>
        ) : null}
      </CardContent>
    </Card>
  );
}

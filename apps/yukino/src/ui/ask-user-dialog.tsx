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
import { useReducer } from "react";

import { SelectorFrame } from "./selector-frame.js";

import type { Question } from "@/tools/ask-user.js";
import { ICONS, THEME } from "@/ui/styles.js";

interface Props {
  questions: Question[];
  onComplete: (answers: Record<string, string>) => void;
}
// ── State management ──

interface QuestionState {
  cursor: number;
  selectedValue?: string | string[];
  textInputValue: string;
  answer?: string;
  otherMode: boolean;
}

interface State {
  currentIndex: number;
  questionStates: QuestionState[];
  submitCursor: number; // 0=Submit, 1=Cancel
}

type Action =
  | { type: "next" }
  | { type: "prev" }
  | { type: "goto"; index: number }
  | { type: "update"; index: number; updates: Partial<QuestionState> }
  | { type: "set-submit-cursor"; cursor: number };

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "next":
      return {
        ...state,
        currentIndex: Math.min(
          state.currentIndex + 1,
          state.questionStates.length,
        ),
      };
    case "prev":
      return { ...state, currentIndex: Math.max(state.currentIndex - 1, 0) };
    case "goto":
      return { ...state, currentIndex: action.index };
    case "update": {
      const qs = [...state.questionStates];
      qs[action.index] = { ...qs[action.index], ...action.updates };
      return { ...state, questionStates: qs };
    }
    case "set-submit-cursor":
      return { ...state, submitCursor: action.cursor };
    default:
      return state;
  }
}

// ── Navigation bar ──

function NavigationBar({
  questions,
  currentIndex,
  states,
  hideSubmit,
}: {
  questions: Question[];
  currentIndex: number;
  states: QuestionState[];
  hideSubmit: boolean;
}) {
  const total = questions.length + (hideSubmit ? 0 : 1);
  const isFirst = currentIndex === 0;
  const isLast = currentIndex >= total - 1;

  return (
    <Box flexDirection="row" marginBottom={1}>
      <Text color={isFirst ? THEME.dim : THEME.text}>{" ← "}</Text>
      {questions.map((q, i) => {
        const active = currentIndex === i;
        const answered = states[i].answer !== undefined;
        const check = answered ? "☑" : "☐";
        if (active) {
          return (
            <Text
              key={i}
              backgroundColor={THEME.selectedBg}
              color={THEME.text}
              bold
            >
              {` ${check} ${q.header} `}
            </Text>
          );
        }
        return (
          <Text key={i} color={answered ? THEME.success : THEME.dim}>
            {` ${check} ${q.header} `}
          </Text>
        );
      })}
      {!hideSubmit &&
        (currentIndex === questions.length ? (
          <Text backgroundColor={THEME.selectedBg} color={THEME.text} bold>
            {" ✓ Submit "}
          </Text>
        ) : (
          <Text color={THEME.dim}>{" ✓ Submit "}</Text>
        ))}
      <Text color={isLast ? THEME.dim : THEME.text}>{" → "}</Text>
    </Box>
  );
}

// ── Question view: compact vertical single/multi-select ──
function QuestionContent({
  question,
  state,
}: {
  question: Question;
  state: QuestionState;
  questionIndex: number;
  totalQuestions: number;
}) {
  const options = question.options;
  const otherIndex = options.length;
  const maxIdxWidth = String(otherIndex + 1).length;

  return (
    <Box flexDirection="column" paddingLeft={1}>
      <Text bold>{question.question}</Text>
      {question.multiSelect && (
        <Text color={THEME.dim}>
          {"  (Space to toggle · Enter to confirm)"}
        </Text>
      )}
      <Text> </Text>
      {options.map((opt, i) => {
        const isFocused = state.cursor === i;
        const isSelected = state.answer === opt.label;
        const idx = String(i + 1).padStart(maxIdxWidth, " ");
        const pointer = isFocused ? ICONS.arrow : " ";
        const checked =
          question.multiSelect &&
          (Array.isArray(state.selectedValue)
            ? state.selectedValue.includes(opt.label)
            : false);
        const checkMark = question.multiSelect ? (checked ? "☑ " : "☐ ") : "";
        const color = isFocused
          ? THEME.accent
          : isSelected
            ? THEME.success
            : THEME.muted;
        return (
          <Box key={opt.label} flexDirection="column">
            <Text>
              <Text color={isFocused ? THEME.accent : THEME.dim}>
                {pointer}
              </Text>
              <Text color={THEME.dim}> {idx}. </Text>
              <Text color={color}>
                {checkMark}
                {opt.label}
              </Text>
            </Text>
            {opt.description && (
              <Box paddingLeft={maxIdxWidth + 5}>
                <Text color={THEME.muted}>{opt.description}</Text>
              </Box>
            )}
          </Box>
        );
      })}
      {/* "Other" option */}
      <Box flexDirection="column">
        <Text>
          <Text color={state.cursor === otherIndex ? THEME.accent : THEME.dim}>
            {state.cursor === otherIndex ? ICONS.arrow : " "}
          </Text>
          <Text color={THEME.dim}>
            {" "}
            {String(otherIndex + 1).padStart(maxIdxWidth, " ")}.{" "}
          </Text>
          <Text color={state.cursor === otherIndex ? THEME.accent : THEME.dim}>
            Other (type your own)
          </Text>
        </Text>
      </Box>
      {state.otherMode && (
        <Box paddingLeft={maxIdxWidth + 5}>
          <Text>
            <Text color={THEME.dim}>{`${ICONS.arrow} `}</Text>
            <Text color={THEME.text}>{state.textInputValue}</Text>
            <Text inverse> </Text>
          </Text>
        </Box>
      )}
    </Box>
  );
}

// ── Submit view ──

function SubmitContent({
  questions,
  states,
  allAnswered,
  submitCursor,
}: {
  questions: Question[];
  states: QuestionState[];
  allAnswered: boolean;
  submitCursor: number;
}) {
  return (
    <Box flexDirection="column" paddingLeft={1}>
      <Text bold>Review your answers</Text>
      <Text> </Text>
      {!allAnswered && (
        <Text color={THEME.warning}>
          {"  Warning: You have not answered all questions"}
        </Text>
      )}
      {questions.map((q, i) => (
        <Box key={q.question} flexDirection="column" marginBottom={0}>
          <Text>
            <Text color={THEME.dim}>{"  • "}</Text>
            <Text>{q.question}</Text>
          </Text>
          {states[i].answer !== undefined ? (
            <Text>
              <Text color={THEME.success}>{"    → "}</Text>
              <Text color={THEME.success}>{states[i].answer}</Text>
            </Text>
          ) : (
            <Text color={THEME.dim}>{"    → (not answered)"}</Text>
          )}
        </Box>
      ))}
      <Text> </Text>
      {allAnswered && (
        <Box flexDirection="column">
          <Text color={THEME.muted}>Ready to submit your answers?</Text>
          <Text> </Text>
          <Text>
            <Text color={submitCursor === 0 ? THEME.accent : THEME.dim}>
              {submitCursor === 0 ? ICONS.arrow : " "}
            </Text>
            <Text
              color={submitCursor === 0 ? THEME.accent : THEME.dim}
              bold={submitCursor === 0}
            >
              {" Submit answers"}
            </Text>
          </Text>
          <Text>
            <Text color={submitCursor === 1 ? THEME.accent : THEME.dim}>
              {submitCursor === 1 ? ICONS.arrow : " "}
            </Text>
            <Text color={submitCursor === 1 ? THEME.accent : THEME.dim}>
              {" Cancel"}
            </Text>
          </Text>
        </Box>
      )}
    </Box>
  );
}

// ── Main component ──

export function AskUserDialog({ questions, onComplete }: Props) {
  const hideSubmit = questions.length === 1 && !questions[0].multiSelect;
  // const totalTabs = questions.length + (hideSubmit ? 0 : 1);

  const [state, dispatch] = useReducer(reducer, {
    currentIndex: 0,
    questionStates: questions.map(
      () =>
        ({
          cursor: 0,
          textInputValue: "",
          otherMode: false,
        }) satisfies QuestionState,
    ),
    submitCursor: 0,
  });

  const { currentIndex, questionStates, submitCursor } = state;
  const isSubmitTab = !hideSubmit && currentIndex === questions.length;
  const q = isSubmitTab ? undefined : questions[currentIndex];
  const qs = isSubmitTab ? undefined : questionStates[currentIndex];
  const allAnswered = questionStates.every((s) => s.answer !== undefined);

  const commitAnswer = (answer: string, advance = true) => {
    dispatch({
      type: "update",
      index: currentIndex,
      updates: { answer, otherMode: false },
    });
    if (advance) {
      if (hideSubmit) {
        // Single-question mode: submit directly
        const answers: Record<string, string> = {};
        answers[questions[0].question] = answer;
        onComplete(answers);
        return;
      }
      dispatch({ type: "next" });
    }
  };

  useInput((input, key) => {
    // Filter out SGR mouse events
    if (input.includes("[<") && /\[<\d+;\d+;\d+[Mm]/.test(input)) {
      return;
    }

    // "Other" free-text input mode
    if (!isSubmitTab && qs?.otherMode) {
      if (key.return) {
        commitAnswer(qs.textInputValue.trim() || "(no answer)");
      } else if (key.backspace || key.delete) {
        dispatch({
          type: "update",
          index: currentIndex,
          updates: {
            textInputValue: qs.textInputValue.slice(0, -1),
          },
        });
      } else if (key.escape) {
        dispatch({
          type: "update",
          index: currentIndex,
          updates: { otherMode: false },
        });
      } else if (input && !key.ctrl && !key.meta) {
        dispatch({
          type: "update",
          index: currentIndex,
          updates: {
            textInputValue: qs.textInputValue + input,
          },
        });
      }
      return;
    }

    if (key.escape) {
      onComplete({});
      return;
    }

    // Tab navigation
    if (key.leftArrow && !isSubmitTab) {
      dispatch({ type: "prev" });
      return;
    }
    if (key.rightArrow && !isSubmitTab) {
      dispatch({ type: "next" });
      return;
    }
    if (key.tab) {
      dispatch({ type: key.shift ? "prev" : "next" });
      return;
    }

    // Submit view
    if (isSubmitTab) {
      if (key.upArrow) {
        dispatch({ type: "set-submit-cursor", cursor: 0 });
        return;
      }
      if (key.downArrow) {
        dispatch({ type: "set-submit-cursor", cursor: 1 });
        return;
      }
      if (key.leftArrow) {
        dispatch({ type: "prev" });
        return;
      }
      if (key.return) {
        if (submitCursor === 0 && allAnswered) {
          const answers: Record<string, string> = {};
          for (let i = 0; i < questions.length; i++) {
            answers[questions[i].question] = questionStates[i].answer ?? "";
          }
          onComplete(answers);
        } else if (submitCursor === 1) {
          onComplete({});
        }
      }
      return;
    }

    if (!q || !qs) {
      return;
    }
    const optCount = q.options.length + 1; // +1 for Other

    // Numeric key shortcuts
    const num = parseInt(input, 10);
    if (num >= 1 && num <= optCount) {
      dispatch({
        type: "update",
        index: currentIndex,
        updates: { cursor: num - 1 },
      });
      return;
    }

    if (key.upArrow) {
      dispatch({
        type: "update",
        index: currentIndex,
        updates: {
          cursor: qs.cursor > 0 ? qs.cursor - 1 : optCount - 1,
        },
      });
    } else if (key.downArrow) {
      dispatch({
        type: "update",
        index: currentIndex,
        updates: {
          cursor: qs.cursor < optCount - 1 ? qs.cursor + 1 : 0,
        },
      });
    } else if (input === " " && q.multiSelect && qs.cursor < q.options.length) {
      const current = Array.isArray(qs.selectedValue)
        ? [...qs.selectedValue]
        : [];
      const label = q.options[qs.cursor].label;
      const idx = current.indexOf(label);
      if (idx >= 0) {
        current.splice(idx, 1);
      } else {
        current.push(label);
      }
      dispatch({
        type: "update",
        index: currentIndex,
        updates: { selectedValue: current },
      });
    } else if (key.return) {
      if (qs.cursor === q.options.length) {
        // Other
        dispatch({
          type: "update",
          index: currentIndex,
          updates: { otherMode: true },
        });
      } else if (q.multiSelect) {
        const selected = Array.isArray(qs.selectedValue)
          ? qs.selectedValue
          : [];
        if (selected.length > 0) {
          commitAnswer(selected.join(", "));
        } else {
          commitAnswer(q.options[qs.cursor]?.label ?? "(unknown)");
        }
      } else {
        commitAnswer(q.options[qs.cursor]?.label ?? "(unknown)");
      }
    }
  });

  // Dynamic help text
  const helpParts: string[] = [];
  if (!isSubmitTab) {
    helpParts.push("Enter to select");
    helpParts.push("↑/↓ to navigate");
    if (questions.length > 1) {
      helpParts.push("Tab/Arrow keys to switch questions");
    }
  }
  helpParts.push("Esc to cancel");
  const helpText = helpParts.join(" · ");

  return (
    <SelectorFrame hint={helpText} title="Answer questions">
      <NavigationBar
        questions={questions}
        currentIndex={currentIndex}
        states={questionStates}
        hideSubmit={hideSubmit}
      />
      {isSubmitTab ? (
        <SubmitContent
          questions={questions}
          states={questionStates}
          allAnswered={allAnswered}
          submitCursor={submitCursor}
        />
      ) : q && qs ? (
        <QuestionContent
          question={q}
          state={qs}
          questionIndex={currentIndex}
          totalQuestions={questions.length}
        />
      ) : null}
    </SelectorFrame>
  );
}

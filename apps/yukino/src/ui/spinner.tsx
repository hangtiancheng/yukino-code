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

import { Text } from "ink";
import React, { useEffect, useRef, useState } from "react";

import { THEME } from "@/ui/styles.js";
import { randomVerb } from "@/utils/verbs.js";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

interface SpinnerProps {
  label?: string;
  inputTokens?: number;
  outputTokens?: number;
}

function formatTokens(value: number): string {
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1)}M`;
  }
  if (value >= 1000) {
    return `${(value / 1000).toFixed(1)}k`;
  }
  return String(value);
}

function Spinner({ label, inputTokens = 0, outputTokens = 0 }: SpinnerProps) {
  const [frame, setFrame] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const verbRef = useRef(label ?? randomVerb());

  useEffect(() => {
    const startedAt = Date.now();
    const animation = setInterval(() => {
      setFrame((current) => (current + 1) % FRAMES.length);
    }, 80);
    const timer = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);
    return () => {
      clearInterval(animation);
      clearInterval(timer);
    };
  }, []);

  const details = [
    inputTokens > 0
      ? `↑${formatTokens(inputTokens)} ↓${formatTokens(outputTokens)}`
      : "",
    elapsed > 0 ? `${String(elapsed)}s` : "",
  ].filter(Boolean);

  return (
    <Text>
      <Text color={THEME.accent}>{FRAMES[frame] ?? FRAMES[0]}</Text>{" "}
      <Text color={THEME.muted}>
        {verbRef.current}
        {details.length > 0 ? ` (${details.join(" · ")})` : ""}
      </Text>
    </Text>
  );
}

export default React.memo(Spinner);

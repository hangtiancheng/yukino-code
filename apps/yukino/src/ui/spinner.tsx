import { Text } from "ink";
import React, { useEffect, useState } from "react";

import { SPINNER_FRAMES, THEME } from "@/ui/constants.js";

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

  useEffect(() => {
    const startedAt = Date.now();
    const animation = setInterval(() => {
      setFrame((current) => (current + 1) % SPINNER_FRAMES.length);
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
      <Text color={THEME.accent}>
        {SPINNER_FRAMES[frame] ?? SPINNER_FRAMES[0]}
      </Text>{" "}
      <Text color={THEME.muted}>
        {label ?? "Working"}
        {details.length > 0 ? ` (${details.join(" · ")})` : ""}
      </Text>
    </Text>
  );
}

export default React.memo(Spinner);

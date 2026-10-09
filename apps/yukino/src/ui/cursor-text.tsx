import {
  Box,
  Text,
  measureElement,
  useBoxMetrics,
  useCursor,
  useStdout,
} from "ink";
import type { DOMElement } from "ink";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

import { visibleWidth } from "./terminal-text.js";
import { useTerminalDimensions } from "./use-terminal-layout.js";

import { registerExitCleanup } from "@/bootstrap/exit-cleanup.js";

function TerminalCursor({ text, color }: { text: string; color?: string }) {
  const ref = useRef<DOMElement>(null);
  const { setCursorPosition } = useCursor();
  const { stdout } = useStdout();
  useTerminalDimensions();
  useBoxMetrics(ref);
  const [position, setPosition] = useState<{ x: number; y: number }>();
  setCursorPosition(position);
  useLayoutEffect(() => {
    if (!ref.current) {
      return;
    }
    const { x, y, width, height } = measureElement(ref.current);
    const next = width > 0 && height > 0 ? { x, y } : undefined;
    setPosition((previous) =>
      previous?.x === next?.x && previous?.y === next?.y ? previous : next,
    );
  });
  useEffect(() => {
    if (!stdout.isTTY) {
      return;
    }
    stdout.write("\x1b[5 q");
    const restore = () => {
      stdout.write("\x1b[0 q");
    };
    const unregister = registerExitCleanup(restore);
    return () => {
      unregister();
      restore();
    };
  }, [stdout]);
  return (
    <Box ref={ref} flexShrink={0} width={Math.max(1, visibleWidth(text))}>
      <Text color={color}>{text}</Text>
    </Box>
  );
}

export function CursorText({
  before,
  current = " ",
  after,
  color,
  active = true,
}: {
  before?: ReactNode;
  current?: string;
  after?: ReactNode;
  color?: string;
  active?: boolean;
}) {
  const ref = useRef<DOMElement>(null);
  useBoxMetrics(ref);
  return (
    <Box ref={ref} flexShrink={0}>
      <Text color={color} wrap="truncate-end">
        {before}
      </Text>
      {active ? (
        <TerminalCursor text={current} color={color} />
      ) : (
        <Text color={color}>{current}</Text>
      )}
      <Text color={color} wrap="truncate-end">
        {after}
      </Text>
    </Box>
  );
}

import { Box, measureElement, useBoxMetrics, useStdout } from "ink";
import type { DOMElement } from "ink";
import { useInsertionEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode, RefObject } from "react";

import { trackTerminalFrame } from "./terminal-output.js";
import {
  AvailableRows,
  useAvailableRows,
  useTerminalDimensions,
} from "./use-terminal-layout.js";

interface ViewportProps {
  children: ReactNode;
  rows: number;
  focusRef?: RefObject<DOMElement | null>;
  followEnd?: boolean;
}

export function ContentViewport({
  children,
  rows,
  focusRef,
  followEnd = false,
}: ViewportProps) {
  const ref = useRef<DOMElement>(null);
  const { height } = useBoxMetrics(ref);
  const [scroll, setScroll] = useState(0);
  const limit = Math.max(0, Math.floor(rows));
  const overflow = Math.max(0, height - limit);
  const offset = followEnd ? overflow : Math.min(scroll, overflow);

  useLayoutEffect(() => {
    if (!ref.current || !focusRef?.current || limit === 0) {
      return;
    }
    const content = measureElement(ref.current);
    const focus = measureElement(focusRef.current);
    const start = focus.y - content.y;
    const end = start + Math.min(focus.height, limit);
    setScroll((current) =>
      Math.max(
        0,
        Math.min(
          overflow,
          start < current
            ? start
            : end > current + limit
              ? end - limit
              : current,
        ),
      ),
    );
  });

  return (
    <Box
      flexDirection="column"
      flexShrink={0}
      maxHeight={limit}
      overflow="hidden"
      width="100%"
    >
      <Box
        ref={ref}
        flexDirection="column"
        flexShrink={0}
        marginTop={-offset}
        width="100%"
      >
        {children}
      </Box>
    </Box>
  );
}

interface TerminalLayoutProps {
  transcript: ReactNode;
  activity: ReactNode;
  status: ReactNode;
  dock: ReactNode;
  footer: ReactNode;
}

export function TerminalLayout({
  transcript,
  activity,
  status,
  dock,
  footer,
}: TerminalLayoutProps) {
  const { stdout } = useStdout();
  const frameRef = useRef<DOMElement>(null);
  useInsertionEffect(
    () =>
      trackTerminalFrame(stdout, () =>
        frameRef.current ? measureElement(frameRef.current).height : 0,
      ),
    [stdout],
  );
  const { columns } = useTerminalDimensions();
  const rows = useAvailableRows();
  const dockRef = useRef<DOMElement>(null);
  const footerRef = useRef<DOMElement>(null);
  const statusRef = useRef<DOMElement>(null);
  const dockMetrics = useBoxMetrics(dockRef);
  const footerMetrics = useBoxMetrics(footerRef);
  const statusMetrics = useBoxMetrics(statusRef);
  const footerBudget = rows >= 12 ? 3 : rows >= 5 ? Math.min(2, rows - 3) : 0;
  const footerRows = footerMetrics.hasMeasured
    ? footerMetrics.height
    : footerBudget;
  const dockGap = rows >= 4 ? 1 : 0;
  const statusBudget = Math.min(
    8,
    Math.max(0, rows - footerRows - dockGap - 3),
  );
  const statusRows =
    rows >= 10 ? Math.min(statusBudget, statusMetrics.height) : 0;
  const dockBudget = Math.max(1, rows - footerRows - statusRows - dockGap);
  const activityRows = Math.max(
    0,
    dockBudget - (dockMetrics.hasMeasured ? dockMetrics.height : 3),
  );

  return (
    <>
      {transcript}
      <Box
        ref={frameRef}
        flexDirection="column"
        width={columns}
        maxHeight={rows}
        overflow="hidden"
      >
        <AvailableRows value={activityRows}>
          <ContentViewport rows={activityRows} followEnd>
            {activity}
          </ContentViewport>
        </AvailableRows>
        <Box flexDirection="column" flexShrink={0} marginTop={dockGap}>
          <AvailableRows value={statusBudget}>
            <Box
              ref={statusRef}
              display={rows >= 10 ? "flex" : "none"}
              flexDirection="column"
              flexShrink={0}
              maxHeight={statusBudget}
              overflow="hidden"
            >
              <Box flexDirection="column" flexShrink={0}>
                {status}
              </Box>
            </Box>
          </AvailableRows>
          <AvailableRows value={dockBudget}>
            <Box
              ref={dockRef}
              flexDirection="column"
              flexShrink={0}
              maxHeight={dockBudget}
              overflow="hidden"
            >
              {dock}
            </Box>
          </AvailableRows>
        </Box>
        <AvailableRows value={footerBudget}>
          <Box ref={footerRef} flexDirection="column" flexShrink={0}>
            {footer}
          </Box>
        </AvailableRows>
      </Box>
    </>
  );
}

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

import { Box, Text } from "ink";
import { useCallback, useImperativeHandle, type Ref } from "react";

import { THEME } from "@/ui/styles.js";

type PropsWithRef<T, R> = T & { ref: Ref<R> };

interface TeammateMessageProps {
  from: string;
  content: string;
  type?: "idle" | "completed" | "text" | "shutdown";
}

interface TeammateMessageExpose {
  parseTeammateMessage: (raw: string) => TeammateMessageProps | null;
}

// Regex for the legacy "[team xxx] sender: message" format. drainLeads now
// emits <task-notification team="..."> XML with "from=<sender>: <text>" lines,
// so this pattern no longer matches its output.
const TEAM_MSG_RE = /^\[team\s+\S+\]\s+(\S+):\s+(.*)$/s;

// Prefixes that indicate special message types.
const IDLE_RE = /^\[idle\]\s*/;
const SHUTDOWN_RE = /^\[shutdown\]\s*/;

/**
 * Renders a teammate message in the chat view.
 *
 * Currently unused: teammate messages reach the conversation through
 * drainLeads' <task-notification> XML instead of this component.
 *
 * - idle / shutdown: silent (return null)
 * - completed: green checkmark + content
 * - text (default): cyan @name with content summary
 */
export function TeammateMessage(props: PropsWithRef<TeammateMessageProps, TeammateMessageExpose>) {
  const { from, content, type = "text", ref } = props;

  /**
   * Parses a teammate message in the legacy "[team xxx] sender: message"
   * format into structured fields.
   *
   * Recognized formats:
   *   "[team alpha] alice: [idle] alice has completed..."  -> { from: "alice", type: "idle", ... }
   *   "[team alpha] bob: [shutdown] ..."                   -> { from: "bob",   type: "shutdown", ... }
   *   "[team alpha] carol: here is my update"              -> { from: "carol", type: "text", ... }
   *
   * Returns null when the string is not a teammate message. Note that
   * drainLeads no longer produces this format, so this always returns null
   * for current drainLeads output.
   */
  const parseTeammateMessage = useCallback((raw: string): TeammateMessageProps | null => {
    const m = TEAM_MSG_RE.exec(raw);
    if (!m) {
      return null;
    }

    const from = m[1];
    const body = m[2];

    if (IDLE_RE.test(body)) {
      return { from, content: body.replace(IDLE_RE, ""), type: "idle" };
    }
    if (SHUTDOWN_RE.test(body)) {
      return {
        from,
        content: body.replace(SHUTDOWN_RE, ""),
        type: "shutdown",
      };
    }

    return { from, content: body, type: "text" };
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      parseTeammateMessage,
    }),
    [parseTeammateMessage],
  );

  if (type === "idle" || type === "shutdown") {
    return null;
  }

  if (type === "completed") {
    return (
      <Box flexDirection="column">
        <Text>
          <Text color={THEME.accent}>@{from}</Text>
          <Text color={THEME.dim}> · </Text>
          <Text color={THEME.success}>✓</Text>
          <Text> Task completed</Text>
        </Text>
        {content ? (
          <Text>
            {"  "}
            {content}
          </Text>
        ) : null}
      </Box>
    );
  }

  // type === "text" (default)
  const lines = content.split("\n");
  const summary = lines[0] ?? "";
  const rest = lines.slice(1).join("\n").trimStart();

  return (
    <Box flexDirection="column">
      <Text>
        <Text color={THEME.accent}>@{from}</Text>
        <Text color={THEME.dim}> · </Text>
        <Text>{summary}</Text>
      </Text>
      {rest ? (
        <Text>
          {"  "}
          {rest}
        </Text>
      ) : null}
    </Box>
  );
}

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

import { THEME } from "@/ui/styles.js";

/**
 * Renders the line-numbered diff text produced by buildDiff() as colored lines:
 * lines starting with "+ " are green, "- " are red, others (context/summary lines) are dimmed.
 */
export function DiffLines({ text }: { text: string }) {
  const lines = text.split("\n");
  return (
    <Box flexDirection="column">
      {lines.map((line, i) => {
        if (line.startsWith("+ ")) {
          return (
            <Text key={i} color={THEME.toolDiffAdded}>
              {line}
            </Text>
          );
        }
        if (line.startsWith("- ")) {
          return (
            <Text key={i} color={THEME.toolDiffRemoved}>
              {line}
            </Text>
          );
        }
        return (
          <Text key={i} color={THEME.toolDiffContext}>
            {line}
          </Text>
        );
      })}
    </Box>
  );
}

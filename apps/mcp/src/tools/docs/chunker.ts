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

import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";

export interface MarkdownChunk {
  content: string;
  title: string;
}

// Sizes match the proven yukino-chatbot RAG setup; 1000 chars stays far below
// both the indexer's 8192-char storage cap and embedding-provider input
// limits, so the embedded text is always identical to the stored text.
export const CHUNK_SIZE = 1000;
export const CHUNK_OVERLAP = 200;

const splitter = RecursiveCharacterTextSplitter.fromLanguage("markdown", {
  chunkSize: CHUNK_SIZE,
  chunkOverlap: CHUNK_OVERLAP,
});

const HEADING_PATTERN = /^#{1,6} +(.+)$/;

function headingsIn(chunk: string): string[] {
  const titles: string[] = [];
  for (const line of chunk.split("\n")) {
    const match = HEADING_PATTERN.exec(line);
    if (match) {
      titles.push(match[1].trim());
    }
  }
  return titles;
}

/**
 * Split markdown into retrieval chunks via LangChain's markdown-aware
 * recursive splitter. Each chunk is annotated with a section title: the first
 * heading inside the chunk, or the nearest heading carried over from earlier
 * chunks (chunks arrive in document order).
 */
export async function splitMarkdown(content: string): Promise<MarkdownChunk[]> {
  const parts = await splitter.splitText(content);
  const chunks: MarkdownChunk[] = [];
  let currentTitle = "";
  for (const part of parts) {
    const titles = headingsIn(part);
    chunks.push({ content: part, title: titles[0] ?? currentTitle });
    if (titles.length > 0) {
      currentTitle = titles[titles.length - 1];
    }
  }
  return chunks;
}

import { renderMarkdownBlock, tokenizeMarkdown } from "@browser/lib/markdown";
import type { Token } from "marked";
import { memo, useEffect, useMemo, useState } from "react";

export const Markdown = memo(function Markdown({
  text,
  className = "",
  user = false,
}: {
  text: string;
  className?: string;
  user?: boolean;
}) {
  const { blocks, references, hasCode } = useMemo(
    () => tokenizeMarkdown(text, user),
    [text, user],
  );
  const [highlight, setHighlight] = useState<(html: string) => string>();
  useEffect(() => {
    if (!highlight && hasCode) {
      void import("../lib/highlight")
        .then((module) => {
          setHighlight(() => module.highlightMarkdown);
        })
        .catch(() => undefined);
    }
  }, [hasCode, highlight]);
  return (
    <div className={`markdown ${className}`}>
      {blocks.map((tokens, index) => (
        <MarkdownBlock
          key={index}
          tokens={tokens}
          references={references}
          user={user}
          highlight={highlight}
        />
      ))}
    </div>
  );
});

interface MarkdownBlockProps {
  tokens: Token[];
  references: string;
  user: boolean;
  highlight: ((html: string) => string) | undefined;
}

const MarkdownBlock = memo(
  function MarkdownBlock({ tokens, user, highlight }: MarkdownBlockProps) {
    const sanitized = renderMarkdownBlock(tokens, user);
    const html =
      highlight && sanitized.includes("<pre")
        ? highlight(sanitized)
        : sanitized;
    return (
      <div
        className="markdown-block"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    );
  },
  (previous, next) =>
    previous.tokens.length === next.tokens.length &&
    previous.tokens.every(
      (token, index) =>
        token.type === next.tokens[index].type &&
        token.raw === next.tokens[index].raw,
    ) &&
    previous.references === next.references &&
    previous.user === next.user &&
    previous.highlight === next.highlight,
);

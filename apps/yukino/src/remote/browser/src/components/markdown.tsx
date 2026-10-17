import { renderMarkdown } from "@browser/lib/markdown";
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
  const [highlight, setHighlight] = useState<(html: string) => string>();
  useEffect(() => {
    if (!highlight && /```|~~~/u.test(text)) {
      void import("../lib/highlight")
        .then((module) => {
          setHighlight(() => module.highlightMarkdown);
        })
        .catch(() => undefined);
    }
  }, [text, highlight]);
  const html = useMemo(() => {
    const sanitized = renderMarkdown(text, user);
    return highlight ? highlight(sanitized) : sanitized;
  }, [text, highlight, user]);
  return (
    <div
      className={`markdown ${className}`}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
});

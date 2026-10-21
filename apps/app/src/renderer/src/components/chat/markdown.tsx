// Assistant markdown rendered with Streamdown: streaming-safe parsing of
// incomplete markdown plus Shiki syntax highlighting via @streamdown/code.

import { code } from "@streamdown/code";
import { Streamdown } from "streamdown";

export function Markdown({
  text,
  streaming = false,
}: {
  text: string;
  streaming?: boolean;
}): React.JSX.Element {
  return (
    <Streamdown
      mode={streaming ? "streaming" : "static"}
      plugins={{ code }}
      lineNumbers={false}
      codeBlockMaxHeight={320}
      className="text-[15px] leading-7"
    >
      {text}
    </Streamdown>
  );
}

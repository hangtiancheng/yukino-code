// Standard pino logger writing to stderr only: the stdio MCP transport owns
// stdout for JSON-RPC frames, so any stray stdout write would corrupt the
// protocol stream.

import pino, { type Logger } from "pino";

export const logger: Logger = pino(
  {
    name: "yukino-mcp",
    errorKey: "err",
  },
  pino.destination(2),
);

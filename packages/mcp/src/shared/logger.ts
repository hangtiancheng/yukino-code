import pino, { type Logger } from "pino";

export const logger: Logger = pino(
  {
    name: "yukino-mcp",
    errorKey: "err",
  },
  pino.destination(2),
);

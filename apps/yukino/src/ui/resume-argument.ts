export function parseResumeArgument(
  args: readonly string[],
): true | string | undefined {
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === "--resume") {
      const sessionId = args[index + 1];
      return sessionId && !sessionId.startsWith("-") ? sessionId : true;
    }
    if (argument?.startsWith("--resume=")) {
      return argument.slice("--resume=".length) || true;
    }
  }
  return undefined;
}

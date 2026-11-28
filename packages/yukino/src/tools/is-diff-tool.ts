export function isDiffTool(toolName: string): boolean {
  return toolName === "EditFile" || toolName === "ApplyPatch";
}

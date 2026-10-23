/** EditFile output is structured diff text; other tools return plain strings */
export function isDiffTool(toolName: string): boolean {
  return toolName === "EditFile";
}

import { resolve, sep } from "node:path";

export function containsPath(base: string, target: string): boolean {
  const resolvedBase = resolve(base);
  const resolvedTarget = resolve(resolvedBase, target);
  if (resolvedTarget === resolvedBase) {
    return true;
  }
  return resolvedTarget.startsWith(resolvedBase + sep);
}

export function sanitizeWorkflowName(name: string): string | null {
  if (typeof name !== "string" || name.length === 0) {
    return null;
  }
  if (name.includes("/") || name.includes("\\")) {
    return null;
  }
  if (name.includes("\0")) {
    return null;
  }
  if (name === "." || name === "..") {
    return null;
  }
  return name;
}

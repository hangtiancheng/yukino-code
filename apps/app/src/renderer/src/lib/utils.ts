export { cn } from "cn";

/** Last path segment of a directory — its display name. */
export function folderName(cwd: string): string {
  const parts = cwd.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? cwd;
}

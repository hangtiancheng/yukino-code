import { realpathSync, lstatSync, readlinkSync } from "node:fs";
import { homedir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

export function resolveToolPath(cwd: string, path: string): string {
  const expanded =
    path === "~"
      ? homedir()
      : path.startsWith("~/") || (sep === "\\" && path.startsWith("~\\"))
        ? join(homedir(), path.slice(2))
        : path;
  return resolve(cwd, expanded);
}

/** Resolve symlinks even when the final file or some parent directories do not exist yet. */
export function canonicalPath(path: string, links = 0): string {
  if (links >= 40) {
    throw new Error("Too many symbolic links while resolving path");
  }
  let current = resolve(path);
  const missing: string[] = [];
  for (;;) {
    try {
      return join(realpathSync(current), ...missing);
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        error.code !== "ENOENT"
      ) {
        throw error;
      }
      const info = lstatSync(current, { throwIfNoEntry: false });
      if (info?.isSymbolicLink()) {
        return canonicalPath(
          resolve(dirname(current), readlinkSync(current), ...missing),
          links + 1,
        );
      }
      const parent = dirname(current);
      if (parent === current) {
        throw error;
      }
      missing.unshift(basename(current));
      current = parent;
    }
  }
}

export function isPathWithin(root: string, path: string): boolean {
  const child = relative(root, path);
  return (
    child === "" ||
    (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child))
  );
}

export function compactPath(path: string): string {
  const home = homedir();
  const homeRelative = relative(home, path);
  if (homeRelative === "") {
    return "~";
  }
  return !homeRelative.startsWith(`..${sep}`) &&
    homeRelative !== ".." &&
    !isAbsolute(homeRelative)
    ? join("~", homeRelative)
    : path;
}

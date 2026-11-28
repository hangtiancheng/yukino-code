import { isAbsolute, normalize, posix, win32 } from "node:path";

import { z } from "zod";

import type { Message } from "@/conversation/index.js";
import { FILE_OPERATIONS_PORTABLE_PATH_RE } from "@/session/constants.js";

function normalizeFilePath(path: string): string {
  if (FILE_OPERATIONS_PORTABLE_PATH_RE.test(path)) {
    return posix.normalize(path.replaceAll("\\", "/"));
  }
  return !isAbsolute(path) && win32.isAbsolute(path)
    ? win32.normalize(path)
    : normalize(path);
}

const FilePathSchema = z
  .string()
  .min(1)
  .refine((path) => !path.includes("\0"))
  .refine((path) =>
    [path, normalizeFilePath(path)].every(
      (value) =>
        isAbsolute(value) ||
        win32.isAbsolute(value) ||
        FILE_OPERATIONS_PORTABLE_PATH_RE.test(value),
    ),
  );
export const FileOperationsSchema = z.strictObject({
  readFiles: z.array(FilePathSchema),
  modifiedFiles: z.array(FilePathSchema),
});
export type FileOperations = z.infer<typeof FileOperationsSchema>;

export function mergeFileOperations(
  ...operations: (FileOperations | undefined)[]
): FileOperations {
  const read = new Set<string>();
  const modified = new Set<string>();
  for (const operation of operations) {
    for (const path of operation?.readFiles ?? []) {
      read.add(normalizeFilePath(path));
    }
    for (const path of operation?.modifiedFiles ?? []) {
      modified.add(normalizeFilePath(path));
    }
  }
  return {
    readFiles: [...read].filter((path) => !modified.has(path)).sort(),
    modifiedFiles: [...modified].sort(),
  };
}

export function declaredFileOperations(
  structuredContent: unknown,
): FileOperations | undefined {
  if (!structuredContent || typeof structuredContent !== "object") {
    return undefined;
  }
  const parsed = FileOperationsSchema.safeParse(
    Reflect.get(structuredContent, "fileOperations"),
  );
  return parsed.success
    ? {
        readFiles: parsed.data.readFiles.map(normalizeFilePath),
        modifiedFiles: parsed.data.modifiedFiles.map(normalizeFilePath),
      }
    : undefined;
}

export function collectFileOperations(
  messages: readonly Message[],
): FileOperations {
  return mergeFileOperations(
    ...messages.flatMap((message) => [
      message.fileOperations,
      ...(message.toolResults ?? []).map((result) =>
        declaredFileOperations(result.structuredContent),
      ),
    ]),
  );
}

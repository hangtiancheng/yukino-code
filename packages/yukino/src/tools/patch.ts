import { parsePatch, type StructuredPatch } from "diff";

export interface FilePatch {
  type: "add" | "delete" | "update";
  path: string;
  movePath?: string;
  patch: StructuredPatch;
}

export function parseFilePatches(text: string): FilePatch[] {
  const patches = parsePatch(text);
  if (!patches.length) {
    throw new Error("A unified diff with file headers is required");
  }
  return patches.map((patch) => {
    if (
      patch.isBinary ||
      patch.isCopy ||
      (patch.isCreate && patch.newMode && patch.newMode !== "100644") ||
      (patch.oldMode && patch.newMode && patch.oldMode !== patch.newMode)
    ) {
      throw new Error(
        "Binary patches, copies and file mode changes are not supported",
      );
    }
    const filePath = (name: string | undefined, prefix: string) => {
      if (!name || name === prefix || name.includes("\0")) {
        throw new Error(
          "Patch file headers must specify non-empty paths without NUL",
        );
      }
      return name.startsWith(prefix) ? name.slice(prefix.length) : name;
    };
    const oldPath = filePath(patch.oldFileName, "a/");
    const newPath = filePath(patch.newFileName, "b/");
    if (oldPath === "/dev/null" && newPath === "/dev/null") {
      throw new Error("A patch must target a file");
    }
    if (
      !patch.hunks.length &&
      oldPath !== "/dev/null" &&
      newPath !== "/dev/null" &&
      !patch.isRename &&
      !patch.isCreate &&
      !patch.isDelete
    ) {
      throw new Error("A patch must contain changes");
    }
    if (oldPath === "/dev/null" || patch.isCreate) {
      return { type: "add", path: newPath, patch };
    }
    if (newPath === "/dev/null" || patch.isDelete) {
      return { type: "delete", path: oldPath, patch };
    }
    return {
      type: "update",
      path: oldPath,
      ...(oldPath !== newPath ? { movePath: newPath } : {}),
      patch,
    };
  });
}

export function patchPaths(text: string): string[] {
  return [
    ...new Set(
      parseFilePatches(text).flatMap((operation) => [
        operation.path,
        ...(operation.movePath ? [operation.movePath] : []),
      ]),
    ),
  ];
}

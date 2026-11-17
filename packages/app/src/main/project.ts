import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";

export class ProjectError extends Error {
  constructor(
    message: string,
    readonly path: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export async function resolveProject(path: string): Promise<string> {
  try {
    const canonical = await realpath(path);
    if (!(await stat(canonical)).isDirectory()) {
      throw new ProjectError(
        "This path is not a folder. Select a project folder.",
        path,
      );
    }
    await access(canonical, constants.R_OK | constants.X_OK);
    return canonical;
  } catch (error) {
    if (error instanceof ProjectError) {
      throw error;
    }
    const code = (error as NodeJS.ErrnoException).code;
    throw new ProjectError(
      code === "ENOENT" || code === "ENOTDIR"
        ? "The project folder was moved or deleted. Select it again."
        : code === "EACCES" || code === "EPERM"
          ? "Cannot access the project folder. Check its permissions or choose another project."
          : "Cannot open the project folder. Select it again.",
      path,
      { cause: error },
    );
  }
}

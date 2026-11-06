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
      throw new ProjectError("此路径不是文件夹，请重新选择项目。", path);
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
        ? "项目文件夹已移动或删除，请重新选择项目。"
        : code === "EACCES" || code === "EPERM"
          ? "无法访问项目文件夹，请检查访问权限或选择其他项目。"
          : "无法打开项目文件夹，请重新选择项目。",
      path,
      { cause: error },
    );
  }
}

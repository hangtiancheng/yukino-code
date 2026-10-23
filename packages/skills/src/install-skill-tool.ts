import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  lstatSync,
  realpathSync,
  openSync,
  closeSync,
  renameSync,
  rmSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { createChildLogger } from "@yukino.js/logger";
import { YUKINO_DIR_NAME } from "@yukino.js/storage/constants.js";
import type {
  Tool,
  ToolContext,
  ToolResult,
  ToolSchema,
} from "@yukino.js/tools/types.js";
import { asErrorString, isRecord, strArg } from "@yukino.js/utils";
import {
  fetchPublicHttpUrl,
  type PublicHttpDependencies,
} from "@yukino.js/utils/public-http.js";
import yaml from "js-yaml";

import { parseSkillFile, type SkillCatalog } from "./catalog.js";
import {
  INVALID_SKILL_NAME_ERROR,
  INVALID_SKILL_SOURCE_ERROR,
  MAX_SKILL_DOWNLOAD_BYTES,
  SKILL_DOWNLOAD_INVALID_CHUNK_ERROR,
  SKILL_DOWNLOAD_INVALID_STREAM_ERROR,
  SKILL_DOWNLOAD_TIMEOUT_ERROR,
  SKILL_DOWNLOAD_TIMEOUT_MS,
  SKILL_DOWNLOAD_TOO_LARGE_ERROR,
  SKILL_FILE_NAME,
  SKILL_NAME_RE,
  SKILLS_DIR_NAME,
  SOURCE_REQUIRED_ERROR,
} from "./constants.js";
import {
  INSTALL_SKILL_DESCRIPTION,
  INSTALL_SKILL_NAME_DESCRIPTION,
  INSTALL_SKILL_SOURCE_DESCRIPTION,
} from "./prompts.js";

const log = createChildLogger({ module: "skills" });

async function readSkillResponse(
  response: Response,
  signal: AbortSignal,
): Promise<string> {
  const contentLength = Number(response.headers.get("content-length"));
  if (
    Number.isFinite(contentLength) &&
    contentLength > MAX_SKILL_DOWNLOAD_BYTES
  ) {
    throw new Error(SKILL_DOWNLOAD_TOO_LARGE_ERROR);
  }
  if (!response.body) {
    return "";
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const result: unknown = await reader.read();
      if (!isRecord(result) || typeof result.done !== "boolean") {
        throw new Error(SKILL_DOWNLOAD_INVALID_STREAM_ERROR);
      }
      if (result.done) {
        break;
      }
      if (!(result.value instanceof Uint8Array)) {
        throw new Error(SKILL_DOWNLOAD_INVALID_CHUNK_ERROR);
      }
      totalBytes += result.value.byteLength;
      if (totalBytes > MAX_SKILL_DOWNLOAD_BYTES) {
        await reader.cancel();
        throw new Error(SKILL_DOWNLOAD_TOO_LARGE_ERROR);
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString("utf8");
}

// Installs a skill from a local file path or an http(s) URL into
// ~/.yukino/skills/<name>/SKILL.md, then reloads the catalog.
export class InstallSkillTool implements Tool {
  name = "InstallSkill";
  description = INSTALL_SKILL_DESCRIPTION;
  category = "write" as const;

  constructor(
    private cwd: string,
    private catalog: SkillCatalog,
    private onInstalled?: () => void,
    private network: PublicHttpDependencies = {},
  ) {}

  schema(): ToolSchema {
    return {
      name: this.name,
      description: this.description,
      input_schema: {
        type: "object",
        properties: {
          source: {
            type: "string",
            description: INSTALL_SKILL_SOURCE_DESCRIPTION,
          },
          name: {
            type: "string",
            description: INSTALL_SKILL_NAME_DESCRIPTION,
          },
        },
        required: ["source"],
      },
    };
  }

  async execute(
    ctx: ToolContext,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const source = strArg(args, "source");
    if (!source) {
      return { output: SOURCE_REQUIRED_ERROR, isError: true };
    }

    try {
      ctx.abortSignal?.throwIfAborted();
      let content: string;
      if (/^https?:\/\//i.test(source)) {
        const timeout = new AbortController();
        const timer = setTimeout(() => {
          timeout.abort(
            new DOMException(SKILL_DOWNLOAD_TIMEOUT_ERROR, "TimeoutError"),
          );
        }, SKILL_DOWNLOAD_TIMEOUT_MS);
        timer.unref();
        const signal = ctx.abortSignal
          ? AbortSignal.any([ctx.abortSignal, timeout.signal])
          : timeout.signal;
        try {
          const resp = await fetchPublicHttpUrl(
            source,
            { signal },
            this.network,
          );
          if (!resp.ok) {
            return {
              output: `Error: fetch failed (${String(resp.status)})`,
              isError: true,
            };
          }
          content = await readSkillResponse(resp, signal);
          signal.throwIfAborted();
        } finally {
          // Keep the timeout active until the response body has been consumed.
          clearTimeout(timer);
        }
      } else {
        content = readFileSync(resolve(this.cwd, source), "utf-8");
      }

      const parsed = parseSkillFile(content);
      if (!parsed) {
        return {
          output: INVALID_SKILL_SOURCE_ERROR,
          isError: true,
        };
      }
      const name = strArg(args, "name") || parsed.meta.name;
      if (!SKILL_NAME_RE.test(name) || name.endsWith(".")) {
        return {
          output: INVALID_SKILL_NAME_ERROR,
          isError: true,
        };
      }
      if (name !== parsed.meta.name) {
        // The catalog indexes the YAML name, so an override must update it too.
        content = `---\n${yaml.dump({ ...parsed.frontmatter, name })}---\n\n${parsed.body}\n`;
      }

      ctx.abortSignal?.throwIfAborted();
      // Resolve the home directory (which may be reached via a symlink), then
      // reject symlinks in every installation component, including dangling links.
      let dir = realpathSync(homedir());
      for (const segment of [YUKINO_DIR_NAME, SKILLS_DIR_NAME, name]) {
        dir = join(dir, segment);
        const stat = lstatSync(dir, { throwIfNoEntry: false });
        if (stat) {
          if (stat.isSymbolicLink() || !stat.isDirectory()) {
            throw new Error(
              `Installation directory must be a real directory: ${dir}`,
            );
          }
        } else {
          mkdirSync(dir);
        }
      }
      const destination = join(dir, SKILL_FILE_NAME);
      const stat = lstatSync(destination, { throwIfNoEntry: false });
      if (stat && (stat.isSymbolicLink() || !stat.isFile())) {
        throw new Error(
          `Installation target must be a regular file: ${destination}`,
        );
      }

      // Replace only this directory entry. This also avoids truncating a file
      // outside the workspace when the old SKILL.md has another hard link.
      const temporary = join(dir, `.SKILL-${randomUUID()}.tmp`);
      const fd = openSync(temporary, "wx", stat?.mode ?? 0o666);
      try {
        try {
          writeFileSync(fd, content, "utf-8");
        } finally {
          closeSync(fd);
        }
        renameSync(temporary, destination);
      } finally {
        rmSync(temporary, { force: true });
      }

      this.catalog.load(this.cwd);
      this.onInstalled?.();
      return {
        output: `Skill '${name}' installed to ${destination}`,
        isError: false,
      };
    } catch (err) {
      log.error({ err }, "skills operation failed");
      return {
        output: `Error installing skill: ${asErrorString(err)}`,
        isError: true,
      };
    }
  }
}

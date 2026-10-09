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

import yaml from "js-yaml";

import { parseSkillFile, type SkillCatalog } from "./catalog.js";

import { createChildLogger } from "@/logger/index.js";
import type {
  Tool,
  ToolContext,
  ToolResult,
  ToolSchema,
} from "@/tools/types.js";
import { asErrorString, isRecord, strArg } from "@/utils/index.js";
import {
  fetchPublicHttpUrl,
  type PublicHttpDependencies,
} from "@/utils/public-http.js";

const log = createChildLogger({ module: "skills" });
const MAX_SKILL_DOWNLOAD_BYTES = 1024 * 1024;

async function readSkillResponse(
  response: Response,
  signal: AbortSignal,
): Promise<string> {
  const contentLength = Number(response.headers.get("content-length"));
  if (
    Number.isFinite(contentLength) &&
    contentLength > MAX_SKILL_DOWNLOAD_BYTES
  ) {
    throw new Error("Skill download exceeds the 1 MiB size limit");
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
        throw new Error("Skill download returned an invalid response stream");
      }
      if (result.done) {
        break;
      }
      if (!(result.value instanceof Uint8Array)) {
        throw new Error("Skill download returned a non-byte response chunk");
      }
      totalBytes += result.value.byteLength;
      if (totalBytes > MAX_SKILL_DOWNLOAD_BYTES) {
        await reader.cancel();
        throw new Error("Skill download exceeds the 1 MiB size limit");
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
  description =
    "Install a skill from a local file path or an http(s) URL into ~/.yukino/skills.";
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
            description:
              "Local file path or raw SKILL.md URL (not an HTML or repository page)",
          },
          name: {
            type: "string",
            description:
              "Optional skill name override; letters, digits, dots, underscores and hyphens",
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
      return { output: "Error: source is required", isError: true };
    }

    try {
      ctx.abortSignal?.throwIfAborted();
      let content: string;
      if (/^https?:\/\//i.test(source)) {
        const timeout = new AbortController();
        const timer = setTimeout(() => {
          timeout.abort(
            new DOMException(
              "Skill download timed out after 30 seconds",
              "TimeoutError",
            ),
          );
        }, 30_000);
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
          output:
            "Error: source must be a valid SKILL.md with a frontmatter name",
          isError: true,
        };
      }
      const name = strArg(args, "name") || parsed.meta.name;
      if (!/^[a-zA-Z0-9_-][a-zA-Z0-9._-]*$/.test(name) || name.endsWith(".")) {
        return {
          output:
            "Error: invalid skill name; use letters, digits, dots, underscores and hyphens",
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
      for (const segment of [".yukino", "skills", name]) {
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
      const destination = join(dir, "SKILL.md");
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

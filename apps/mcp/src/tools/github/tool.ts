import { z } from "zod";

import { loadConfig } from "@/shared/config.js";
import { TOOL_NAMES } from "@/tools/names.js";
import {
  operationError,
  operationResult,
  unrestrictedAnnotations,
} from "@/tools/operations/shared.js";
import type { ToolModule } from "@/tools/types.js";
import { runGh } from "./runner.js";

function ghEnvironment(): NodeJS.ProcessEnv {
  const config = loadConfig().github;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GH_PROMPT_DISABLED: "1",
    GH_PAGER: "cat",
  };
  const hostname =
    config.hostname || (config.baseUrl ? new URL(config.baseUrl).host : "");
  if (hostname)
    env["GH_HOST"] = hostname === "api.github.com" ? "github.com" : hostname;
  if (config.token) {
    if (
      hostname &&
      hostname !== "github.com" &&
      hostname !== "api.github.com" &&
      !hostname.endsWith(".ghe.com")
    ) {
      if (!env["GH_ENTERPRISE_TOKEN"] && !env["GITHUB_ENTERPRISE_TOKEN"])
        env["GH_ENTERPRISE_TOKEN"] = config.token;
    } else if (!env["GH_TOKEN"]) {
      env["GH_TOKEN"] = config.token;
    }
  }
  return env;
}

export const githubModule: ToolModule = {
  name: "github",
  register(server) {
    server.registerTool(
      TOOL_NAMES.githubTool,
      {
        title: "GitHub CLI",
        description:
          'Run any GitHub CLI (gh) command. Supply args without the leading gh, e.g. ["pr","list","--repo","owner/repo","--json","number,title"]. Covers repositories, issues, PRs/reviews/merges, Actions, releases/assets, projects and every REST/GraphQL endpoint via gh api. Use --help to discover commands, --json/--jq for focused results, and gh api --paginate --slurp for pagination. stdin supports --input - (JSON/binary-as-text payloads), --body-file - and other stdin-based flags. cwd selects the local repository for checkout/clone/git operations. No command allowlist or confirmation step. Requires gh on PATH; authentication uses gh auth login or GH_TOKEN/GITHUB_TOKEN (Enterprise: GH_HOST/GH_ENTERPRISE_TOKEN). Returns stdout, stderr, exit_code, signal, timed_out and cancelled; nonzero exits, timeouts or cancellation are errors. Use response_format=base64 for binary stdout.',
        inputSchema: {
          args: z
            .array(z.string())
            .min(1)
            .describe(
              "Ordered gh arguments without the executable name. Each element is one argument, sent verbatim without shell parsing.",
            ),
          cwd: z
            .string()
            .min(1)
            .optional()
            .describe(
              "Working directory; defaults to the MCP process directory.",
            ),
          stdin: z
            .string()
            .optional()
            .describe(
              "Text sent verbatim to stdin, e.g. a JSON body for gh api --input -.",
            ),
          timeout_ms: z
            .number()
            .int()
            .positive()
            .default(60_000)
            .describe(
              "Subprocess timeout in milliseconds; increase for long-running commands.",
            ),
          response_format: z
            .enum(["text", "base64"])
            .default("text")
            .describe(
              "Encoding of stdout; base64 preserves binary API downloads.",
            ),
        },
        annotations: unrestrictedAnnotations,
      },
      async ({ args, cwd, stdin, timeout_ms, response_format }, extra) => {
        try {
          const result = await runGh(args, {
            cwd,
            stdin,
            timeoutMs: timeout_ms,
            env: ghEnvironment(),
            signal: extra.signal,
          });
          const output = operationResult({
            ...result,
            stdout: result.stdout.toString(
              response_format === "base64" ? "base64" : "utf8",
            ),
          });
          return result.exit_code !== 0 || result.timed_out || result.cancelled
            ? { ...output, isError: true }
            : output;
        } catch (error) {
          if (
            error instanceof Error &&
            "code" in error &&
            error.code === "ENOENT"
          ) {
            return operationError(
              TOOL_NAMES.githubTool,
              new Error(
                "Unable to start gh. Install GitHub CLI and ensure gh is on PATH; check cwd if supplied. Authenticate with gh auth login or set GH_TOKEN/GITHUB_TOKEN.",
              ),
            );
          }
          return operationError(TOOL_NAMES.githubTool, error);
        }
      },
    );
  },
};

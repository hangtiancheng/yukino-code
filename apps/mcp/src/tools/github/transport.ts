// Transports for the GitHub REST API.
//
// Two interchangeable transports back the github_* tools:
//
// - GhCliTransport shells out to the local `gh` CLI (`gh api ...`) when it is
//   installed and authenticated. It reuses the machine's existing GitHub login
//   (keyring / GH_TOKEN / GH Enterprise host), so no extra configuration is
//   needed and no token ever passes through this process.
// - HttpTransport talks to the REST API directly with fetch and a bearer
//   token, for machines without a usable `gh` CLI. The token comes from the
//   GITHUB_TOKEN (or GH_TOKEN) env var and is secret: it is only ever sent in
//   an Authorization header and never logged.
//
// resolveTransport picks between them per call — authenticated gh CLI first,
// then the token transport, then null ("unavailable") — so configuration set
// after the server instance was built is picked up.

import { spawn } from "node:child_process";

/** REST API base used when GITHUB_BASE_URL is unset. */
export const DEFAULT_API_BASE_URL = "https://api.github.com";

/**
 * Requests are low-frequency; generous bounds that still cannot hang a tool
 * call forever.
 */
const REQUEST_TIMEOUT_MS = 30_000;

/** Bound for a single `gh api` subprocess (network + gh startup). */
const GH_CLI_TIMEOUT_MS = 30_000;

/** Bound for the local `gh auth status` availability check. */
const GH_AUTH_CHECK_TIMEOUT_MS = 10_000;

/** Thrown for non-2xx responses, gh CLI failures or malformed payloads. */
export class GitHubError extends Error {
  readonly status: number | null;

  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = "GitHubError";
    this.status = status;
  }
}

export interface GitHubRequestOptions {
  query?: Record<string, string | number> | undefined;
  jsonBody?: Record<string, unknown> | undefined;
}

/**
 * One GitHub REST call: an API path (e.g. `/repos/o/r`) in, decoded JSON out
 * (null for empty bodies).
 */
export interface GitHubTransport {
  request(
    method: string,
    apiPath: string,
    options?: GitHubRequestOptions,
  ): Promise<unknown>;
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function urlWithQuery(
  apiPath: string,
  query?: Record<string, string | number>,
): string {
  if (query === undefined || Object.keys(query).length === 0) {
    return apiPath;
  }
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    params.set(key, String(value));
  }
  return `${apiPath}?${params.toString()}`;
}

/**
 * gh api reports failures like `gh: HTTP 404: Not Found`; keep the status so
 * callers can distinguish auth (401/403) from missing (404).
 */
export function statusFromGhStderr(stderr: string): number | null {
  const match = /HTTP (\d{3})/.exec(stderr);
  return match === null ? null : Number.parseInt(match[1], 10);
}

interface ProcessResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/**
 * Run a subprocess without a shell, collecting stdout/stderr. Rejects when the
 * executable cannot be spawned (ENOENT etc.); resolves with timedOut=true when
 * the timeout killed it.
 */
function runProcess(
  executable: string,
  args: string[],
  options: { stdin?: string | undefined; timeoutMs: number },
): Promise<ProcessResult> {
  return new Promise<ProcessResult>((resolve, reject) => {
    const child = spawn(executable, args, { stdio: "pipe" });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, options.timeoutMs);

    child.on("error", (err: Error) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf-8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf-8");
    });
    child.on("close", (code: number | null) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        resolve({ exitCode: code, stdout, stderr, timedOut });
      }
    });

    // A vanished process must not turn the stdin write into an unhandled
    // EPIPE; the close/error handlers report the real outcome.
    child.stdin.on("error", () => {
      /** noop */
    });
    child.stdin.end(options.stdin ?? "");
  });
}

/**
 * Runs `gh api` as a subprocess; authentication is the gh CLI's own (keyring,
 * GH_TOKEN, ...), so this transport holds no credentials.
 */
export class GhCliTransport implements GitHubTransport {
  private readonly ghExecutable: string;

  constructor(ghExecutable = "gh") {
    this.ghExecutable = ghExecutable;
  }

  async request(
    method: string,
    apiPath: string,
    options?: GitHubRequestOptions,
  ): Promise<unknown> {
    const args = [
      "api",
      "--method",
      method,
      urlWithQuery(apiPath, options?.query),
    ];
    let stdin: string | undefined;
    if (options?.jsonBody !== undefined) {
      // The body goes through stdin (`--input -`) rather than argv: no shell
      // involved, no size limit, no escaping concerns.
      args.push("--input", "-");
      stdin = JSON.stringify(options.jsonBody);
    }

    let result: ProcessResult;
    try {
      result = await runProcess(this.ghExecutable, args, {
        stdin,
        timeoutMs: GH_CLI_TIMEOUT_MS,
      });
    } catch (err) {
      throw new GitHubError(`Failed to run the gh CLI: ${errorMessage(err)}`);
    }

    if (result.timedOut) {
      throw new GitHubError(
        `gh api timed out after ${String(GH_CLI_TIMEOUT_MS / 1000)}s for ${apiPath}`,
      );
    }
    if (result.exitCode !== 0) {
      const message = result.stderr.trim().slice(0, 300);
      throw new GitHubError(
        `gh api failed for ${apiPath}: ${message === "" ? "unknown error" : message}`,
        statusFromGhStderr(message),
      );
    }

    const text = result.stdout.trim();
    if (text === "") {
      return null;
    }
    try {
      const parsed: unknown = JSON.parse(text);
      return parsed;
    } catch {
      throw new GitHubError(
        `gh api returned a non-JSON response for ${apiPath}`,
      );
    }
  }
}

/** Direct REST calls with a personal access token as a bearer token. */
export class HttpTransport implements GitHubTransport {
  private readonly token: string;
  private readonly baseUrl: string;

  constructor(token: string, baseUrl: string = DEFAULT_API_BASE_URL) {
    if (token === "") {
      throw new GitHubError(
        "No GitHub token: set the GITHUB_TOKEN env var (MCP client env " +
          "or .env) to a personal access token with repo access, or " +
          "authenticate the gh CLI (gh auth login).",
      );
    }
    this.token = token;
    this.baseUrl = baseUrl;
  }

  async request(
    method: string,
    apiPath: string,
    options?: GitHubRequestOptions,
  ): Promise<unknown> {
    const url = new URL(`${this.baseUrl}${apiPath}`);
    for (const [key, value] of Object.entries(options?.query ?? {})) {
      url.searchParams.set(key, String(value));
    }

    const headers: Record<string, string> = {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${this.token}`,
      "x-github-api-version": "2022-11-28",
    };
    let body: string | undefined;
    if (options?.jsonBody !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(options.jsonBody);
    }

    // redirect: "follow" — renamed/moved repositories answer 301 with the new
    // API URL (the gh CLI follows those too). Node's fetch strips the
    // Authorization header when a redirect leaves the origin, so the token
    // cannot leak to a third host.
    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers,
        body: body ?? null,
        redirect: "follow",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      throw new GitHubError(
        `GitHub API request for ${apiPath} failed: ${errorMessage(err)}`,
      );
    }

    if (!response.ok) {
      const text = (await response.text()).slice(0, 200);
      throw new GitHubError(
        `GitHub API error ${String(response.status)} for ${apiPath}: ${text}`,
        response.status,
      );
    }
    const text = await response.text();
    if (text === "") {
      return null;
    }
    const parsed: unknown = JSON.parse(text);
    return parsed;
  }
}

/**
 * True when the gh CLI is installed AND authenticated.
 *
 * `gh auth status` reads gh's local credential store (no network round trip),
 * so the check is cheap enough to run per tool call and the decision stays
 * fresh — logging in or out takes effect immediately.
 */
export async function ghCliIsAvailable(ghExecutable = "gh"): Promise<boolean> {
  try {
    const result = await runProcess(ghExecutable, ["auth", "status"], {
      timeoutMs: GH_AUTH_CHECK_TIMEOUT_MS,
    });
    return !result.timedOut && result.exitCode === 0;
  } catch {
    // Not on PATH (ENOENT) or not executable.
    return false;
  }
}

export interface ResolveTransportOptions {
  token?: string | undefined;
  baseUrl?: string | undefined;
}

/**
 * Pick the transport for one tool call: the authenticated gh CLI when usable,
 * else the token HTTP transport, else null ("unavailable").
 *
 * `baseUrl` (GITHUB_BASE_URL) only applies to the HTTP transport; the gh CLI
 * resolves its host on its own (GH_HOST / gh auth status).
 */
export async function resolveTransport(
  options: ResolveTransportOptions = {},
): Promise<GitHubTransport | null> {
  if (await ghCliIsAvailable()) {
    return new GhCliTransport();
  }
  const token = options.token ?? "";
  if (token !== "") {
    const baseUrl = options.baseUrl ?? "";
    return new HttpTransport(
      token,
      baseUrl === "" ? DEFAULT_API_BASE_URL : baseUrl,
    );
  }
  return null;
}

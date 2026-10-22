import { execFile, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify, stripVTControlCharacters } from "node:util";

import { z } from "zod";

import {
  DESIRED_LABELS,
  FEEDBACK_REPO,
  GITHUB_ERROR_DETAIL_CHARS,
  GIST_FILENAME,
  GIST_MAX_ATTEMPTS,
  GIST_RETRY_DELAY_MS,
  GIST_UPLOAD_TOO_LARGE_MESSAGE,
  GH_COMMAND_FAILED_MESSAGE,
  GH_UPLOAD_TIMEOUT_MS,
  GITHUB_URL_LIMIT,
  MAX_GIST_BYTES,
  NETWORK_TIMEOUT_MS,
  NO_GITHUB_TOKEN_MESSAGE,
  PROBE_TIMEOUT_MS,
} from "@/feedback/constants.js";
import type { CollectedFile, FeedbackChannel } from "@/feedback/types.js";
import { writePrivateFileSync as writeFileSync } from "@/storage/private.js";
import { version } from "@/version.js";

const execFileAsync = promisify(execFile);

class GitHubRequestError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

const GhErrorSchema = z.object({
  stderr: z.string().optional(),
  code: z.union([z.string(), z.number()]).optional(),
});

function conciseDetail(text: string): string {
  return stripVTControlCharacters(text)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, GITHUB_ERROR_DETAIL_CHARS);
}

async function runGh(
  args: string[],
  options: { timeout: number; signal?: AbortSignal },
): Promise<{ stdout: string }> {
  try {
    return await execFileAsync("gh", args, options);
  } catch (error) {
    options.signal?.throwIfAborted();
    const parsed = GhErrorSchema.safeParse(error);
    const stderr = parsed.success ? parsed.data.stderr : undefined;
    const status = /\bHTTP\s+(\d{3})\b/i.exec(stderr ?? "");
    const detail = stderr
      ? conciseDetail(stderr)
      : `${GH_COMMAND_FAILED_MESSAGE}${parsed.success && parsed.data.code ? ` (${String(parsed.data.code)})` : ""}`;
    throw new GitHubRequestError(
      detail,
      status ? Number(status[1]) : undefined,
    );
  }
}

function githubToken(): string | undefined {
  return process.env.GH_TOKEN || process.env.GITHUB_TOKEN || undefined;
}

/** gh CLI (authenticated) → GITHUB_TOKEN/GH_TOKEN → prefilled browser URL. */
export async function detectChannel(): Promise<FeedbackChannel> {
  try {
    await execFileAsync("gh", ["--version"], { timeout: PROBE_TIMEOUT_MS });
    await execFileAsync("gh", ["auth", "status"], { timeout: 5_000 });
    return "gh";
  } catch {
    // gh missing or not logged in — fall through to the token check.
  }
  if (githubToken()) {
    return "token";
  }
  return "browser";
}

function networkSignal(abortSignal?: AbortSignal): AbortSignal {
  const signals = [AbortSignal.timeout(NETWORK_TIMEOUT_MS)];
  if (abortSignal) {
    signals.push(abortSignal);
  }
  return AbortSignal.any(signals);
}

function apiHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "User-Agent": `yukino-feedback/${version}`,
    "X-GitHub-Api-Version": "2022-11-28",
    "Content-Type": "application/json",
  };
}

async function errorDetail(response: Response): Promise<string> {
  const text = await response.text().catch(() => "");
  return text
    ? `${String(response.status)} ${conciseDetail(text)}`
    : String(response.status);
}

async function uploadGist(
  channel: "gh" | "token",
  content: string,
  description: string,
  abortSignal?: AbortSignal,
): Promise<string> {
  if (channel === "gh") {
    const dir = mkdtempSync(join(tmpdir(), "yukino-feedback-"));
    try {
      const target = join(dir, GIST_FILENAME);
      writeFileSync(target, content);
      const { stdout } = await runGh(
        ["gist", "create", target, "--desc", description],
        { timeout: GH_UPLOAD_TIMEOUT_MS, signal: abortSignal },
      );
      const url = stdout.trim().split("\n").pop() ?? "";
      if (!url.startsWith("https://")) {
        throw new Error(`Unexpected gh gist output: ${url.slice(0, 100)}`);
      }
      return url;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  const token = githubToken();
  if (!token) {
    throw new Error(NO_GITHUB_TOKEN_MESSAGE);
  }
  const response = await fetch("https://api.github.com/gists", {
    method: "POST",
    headers: apiHeaders(token),
    body: JSON.stringify({
      description,
      public: false,
      files: { [GIST_FILENAME]: { content } },
    }),
    signal: networkSignal(abortSignal),
  });
  if (!response.ok) {
    throw new GitHubRequestError(
      `Gist creation failed: ${await errorDetail(response)}`,
      response.status,
    );
  }
  const json: unknown = await response.json().catch(() => null);
  const parsed = z.object({ html_url: z.string() }).safeParse(json);
  if (!parsed.success) {
    throw new Error("Gist response missing html_url");
  }
  return parsed.data.html_url;
}

export async function createGist(
  channel: "gh" | "token",
  files: CollectedFile[],
  description: string,
  abortSignal?: AbortSignal,
): Promise<string> {
  abortSignal?.throwIfAborted();
  if (files.length === 0) {
    throw new Error("No attachment files to upload");
  }
  const content = `${JSON.stringify({ files })}\n`;
  if (Buffer.byteLength(content) > MAX_GIST_BYTES) {
    throw new Error(GIST_UPLOAD_TOO_LARGE_MESSAGE);
  }
  for (let attempt = 1; ; attempt++) {
    abortSignal?.throwIfAborted();
    try {
      return await uploadGist(channel, content, description, abortSignal);
    } catch (error) {
      abortSignal?.throwIfAborted();
      if (
        !(error instanceof GitHubRequestError) ||
        !error.status ||
        error.status < 500 ||
        error.status >= 600 ||
        attempt >= GIST_MAX_ATTEMPTS
      ) {
        throw error;
      }
      await delay(GIST_RETRY_DELAY_MS * 2 ** (attempt - 1), undefined, {
        signal: abortSignal,
      });
    }
  }
}

const LabelsPageSchema = z.array(z.object({ name: z.string() }));
// gh api --paginate --slurp wraps every page into one outer array.
const SlurpedLabelsSchema = z.array(LabelsPageSchema);

/** Best-effort: labels only filter the request, they never block filing. */
export async function fetchRepoLabels(
  channel: "gh" | "token",
  abortSignal?: AbortSignal,
): Promise<string[]> {
  try {
    if (channel === "gh") {
      const { stdout } = await runGh(
        [
          "api",
          `repos/${FEEDBACK_REPO}/labels?per_page=100`,
          "--paginate",
          "--slurp",
        ],
        { timeout: NETWORK_TIMEOUT_MS, signal: abortSignal },
      );
      const json: unknown = JSON.parse(stdout);
      const parsed = SlurpedLabelsSchema.safeParse(json);
      return parsed.success ? parsed.data.flat().map((l) => l.name) : [];
    }
    const token = githubToken();
    if (!token) {
      return [];
    }
    const response = await fetch(
      `https://api.github.com/repos/${FEEDBACK_REPO}/labels?per_page=100`,
      { headers: apiHeaders(token), signal: networkSignal(abortSignal) },
    );
    if (!response.ok) {
      return [];
    }
    const json: unknown = await response.json().catch(() => null);
    const parsed = LabelsPageSchema.safeParse(json);
    return parsed.success ? parsed.data.map((l) => l.name) : [];
  } catch {
    return [];
  }
}

export function desiredLabels(existing: string[]): string[] {
  return DESIRED_LABELS.filter((label) => existing.includes(label));
}

const IssueResponseSchema = z.object({
  html_url: z.string(),
  number: z.number(),
});

export interface IssueResult {
  url: string;
  number?: number;
}

export async function createIssue(
  channel: "gh" | "token",
  title: string,
  body: string,
  labels: string[],
  abortSignal?: AbortSignal,
): Promise<IssueResult> {
  if (channel === "gh") {
    const labelArgs = labels.flatMap((label) => ["--label", label]);
    const { stdout } = await runGh(
      [
        "issue",
        "create",
        "--repo",
        FEEDBACK_REPO,
        "--title",
        title,
        "--body",
        body,
        ...labelArgs,
      ],
      { timeout: NETWORK_TIMEOUT_MS, signal: abortSignal },
    );
    const url = stdout.trim().split("\n").pop() ?? "";
    if (!url.startsWith("https://")) {
      throw new Error(`Unexpected gh issue output: ${url.slice(0, 100)}`);
    }
    const numberMatch = /\/issues\/(\d+)/.exec(url);
    return {
      url,
      number: numberMatch ? Number.parseInt(numberMatch[1], 10) : undefined,
    };
  }

  const token = githubToken();
  if (!token) {
    throw new Error(NO_GITHUB_TOKEN_MESSAGE);
  }
  const response = await fetch(
    `https://api.github.com/repos/${FEEDBACK_REPO}/issues`,
    {
      method: "POST",
      headers: apiHeaders(token),
      body: JSON.stringify({ title, body, labels }),
      signal: networkSignal(abortSignal),
    },
  );
  if (!response.ok) {
    throw new Error(`Issue creation failed: ${await errorDetail(response)}`);
  }
  const json: unknown = await response.json().catch(() => null);
  const parsed = IssueResponseSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error("Issue response missing html_url");
  }
  return { url: parsed.data.html_url, number: parsed.data.number };
}

/**
 * Do not cut inside a %XX escape sequence, and do not cut a multi-byte UTF-8
 * character in half — an incomplete trailing character makes the whole URL
 * undecodable (URIError on the GitHub side).
 */
function truncateEncoded(encoded: string, max: number): string {
  if (max <= 0) {
    return "";
  }
  let out = encoded.slice(0, max);
  const lastPercent = out.lastIndexOf("%");
  if (lastPercent >= out.length - 2) {
    out = out.slice(0, lastPercent);
  }
  const trailing = /(?:%[0-9A-Fa-f]{2})+$/.exec(out);
  if (!trailing) {
    return out;
  }
  const seq = trailing[0];
  const bytes: number[] = [];
  for (let i = 0; i < seq.length; i += 3) {
    bytes.push(Number.parseInt(seq.slice(i + 1, i + 3), 16));
  }
  // Walk back over continuation bytes (10xxxxxx) to the character's lead byte.
  let lead = bytes.length - 1;
  while (lead >= 0 && (bytes[lead] & 0xc0) === 0x80) {
    lead--;
  }
  if (lead < 0) {
    return out;
  }
  const leadByte = bytes[lead];
  const expected =
    leadByte < 0x80 ? 1 : leadByte >= 0xf0 ? 4 : leadByte >= 0xe0 ? 3 : 2;
  const actual = bytes.length - lead;
  if (actual < expected) {
    out = out.slice(0, out.length - actual * 3);
  }
  return out;
}

/** Prefilled issues/new URL for the no-auth fallback. */
export function buildIssueUrl(title: string, body: string): string {
  const prefix = `https://github.com/${FEEDBACK_REPO}/issues/new?title=${encodeURIComponent(title)}&body=`;
  const suffix = encodeURIComponent("\n\n…(content truncated to fit the URL)");
  let encoded = encodeURIComponent(body);
  const budget = GITHUB_URL_LIMIT - prefix.length;
  if (encoded.length > budget) {
    encoded = truncateEncoded(encoded, budget - suffix.length) + suffix;
  }
  return prefix + encoded;
}

/** Best-effort: spawn the platform opener detached and ignore failures. */
export function openInBrowser(url: string): void {
  let command: string;
  let args: string[];
  if (process.platform === "darwin") {
    command = "open";
    args = [url];
  } else if (process.platform === "win32") {
    command = "cmd";
    // Quote the URL: prefilled issue URLs contain & separators.
    args = ["/c", "start", "", `"${url}"`];
  } else {
    command = "xdg-open";
    args = [url];
  }
  try {
    const child = spawn(command, args, { stdio: "ignore", detached: true });
    child.on("error", () => {
      // Best effort only.
    });
    child.unref();
  } catch {
    // Best effort only.
  }
}

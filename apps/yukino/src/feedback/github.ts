import { execFile, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { z } from "zod";

import type { CollectedFile, FeedbackChannel } from "./types.js";

import { version } from "@/version.js";

const execFileAsync = promisify(execFile);

export const FEEDBACK_REPO_OWNER = "hangtiancheng";
export const FEEDBACK_REPO_NAME = "yukino-code";
export const FEEDBACK_REPO = `${FEEDBACK_REPO_OWNER}/${FEEDBACK_REPO_NAME}`;
const DESIRED_LABELS = ["bug", "yukino-feedback"];

// Empirically safe limit for GitHub's issues/new prefill URL.
const GITHUB_URL_LIMIT = 7250;
const NETWORK_TIMEOUT_MS = 30_000;
const GH_UPLOAD_TIMEOUT_MS = 60_000;
const PROBE_TIMEOUT_MS = 3_000;

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
    ? `${String(response.status)} ${text.slice(0, 200)}`
    : String(response.status);
}

/** Gist file names cannot contain path separators. */
function flattenName(name: string): string {
  return name.replace(/[^\w.-]+/g, "_");
}

function gistContent(content: string): string {
  return content.trim()
    ? content
    : `${JSON.stringify({
        _note:
          "Empty or whitespace-only attachment. Original content is JSON-encoded in content.",
        content,
      })}\n`;
}

export async function createGist(
  channel: "gh" | "token",
  files: CollectedFile[],
  description: string,
  abortSignal?: AbortSignal,
): Promise<string> {
  if (files.length === 0) {
    throw new Error("No attachment files to upload");
  }
  const gistFiles: Record<string, { content: string }> = {};
  for (const file of files) {
    gistFiles[flattenName(file.name)] = { content: gistContent(file.content) };
  }
  if (channel === "gh") {
    const dir = mkdtempSync(join(tmpdir(), "yukino-feedback-"));
    try {
      const paths: string[] = [];
      for (const [name, file] of Object.entries(gistFiles)) {
        const target = join(dir, name);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, file.content);
        paths.push(target);
      }
      const { stdout } = await execFileAsync(
        "gh",
        ["gist", "create", ...paths, "--desc", description],
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
    throw new Error("No GitHub token available");
  }
  const response = await fetch("https://api.github.com/gists", {
    method: "POST",
    headers: apiHeaders(token),
    body: JSON.stringify({ description, public: false, files: gistFiles }),
    signal: networkSignal(abortSignal),
  });
  if (!response.ok) {
    throw new Error(`Gist creation failed: ${await errorDetail(response)}`);
  }
  const json: unknown = await response.json().catch(() => null);
  const parsed = z.object({ html_url: z.string() }).safeParse(json);
  if (!parsed.success) {
    throw new Error("Gist response missing html_url");
  }
  return parsed.data.html_url;
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
      const { stdout } = await execFileAsync(
        "gh",
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
    const { stdout } = await execFileAsync(
      "gh",
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
    throw new Error("No GitHub token available");
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

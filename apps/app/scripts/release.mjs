#!/usr/bin/env node

/**
 * Release script
 *
 * Usage:
 *   node release.mjs              # dry-run, build only without publishing
 *   node release.mjs win          # publish for Windows
 *   node release.mjs mac          # publish for macOS
 *   node release.mjs linux        # publish for Linux
 *   node release.mjs all          # publish for all platforms
 *
 * Environment variables:
 *   GH_TOKEN - GitHub Personal Access Token (required for publishing to GitHub Releases)
 */

import "dotenv/config";
import { execSync } from "child_process";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf-8"));
const version = pkg.version;

const platform = process.argv[2] || "";
const validPlatforms = ["win", "mac", "linux", "all"];

if (platform && !validPlatforms.includes(platform)) {
  console.error(`Invalid platform: ${platform}`);
  console.error(
    `Supported: ${validPlatforms.join(", ")} or leave empty (dry-run)`,
  );
  process.exit(1);
}

const dryRun = !platform;

console.log(`Version: v${version}`);
console.log(
  `Mode: ${dryRun ? "dry-run (build only, no publish)" : `Publish ${platform}`}`,
);
console.log("");

// Build
console.log("Running typecheck + build...");
execSync("pnpm build", { stdio: "inherit", cwd: root });

// Package + publish
const publishFlag = dryRun ? "" : "--publish always";
const platformFlags = [];

if (platform === "win" || platform === "all") platformFlags.push("--win");
if (platform === "mac" || platform === "all") platformFlags.push("--mac");
if (platform === "linux" || platform === "all") platformFlags.push("--linux");

if (dryRun) {
  platformFlags.push("--dir");
}

if (!dryRun && !process.env.GH_TOKEN) {
  console.error(
    "Error: GH_TOKEN environment variable is required for publish mode",
  );
  process.exit(1);
}

const args = [...platformFlags, ...publishFlag.split(" ").filter(Boolean)].join(
  " ",
);
const cmd = `node ./node_modules/electron-builder/cli.js ${args}`.trim();
console.log(`Executing: ${cmd}`);
execSync(cmd, { stdio: "inherit", cwd: root });

console.log("");
if (dryRun) {
  console.log(`dry-run complete, artifacts in dist/ directory`);
} else {
  console.log(`v${version} published to GitHub Releases`);
}

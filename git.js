/**
 * Copyright (c) 2026 hangtiancheng
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

import { exec } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";

const execAsync = promisify(exec);

/**
 * Parse CLI arguments into source and target zip paths, split by `--`.
 * Usage: node git.js <source_zips...> -- <target_zips...>
 * @returns {{ sources: string[], targets: string[] }}
 */
function parseArgs() {
  const args = process.argv.slice(2);
  const sep = args.indexOf("--");
  if (sep === -1) {
    console.error("Usage: node git.js <source_zips...> -- <target_zips...>");
    process.exit(1);
  }
  const sources = args.slice(0, sep).map((p) => path.resolve(p));
  const targets = args.slice(sep + 1).map((p) => path.resolve(p));
  return { sources, targets };
}

/**
 * Validate that sources and targets have equal length
 * and every path is an existing file.
 * @param {string[]} sources
 * @param {string[]} targets
 * @returns {void}
 */
function validate(sources, targets) {
  if (sources.length !== targets.length) {
    console.error(
      `sources (${sources.length}) and targets (${targets.length}) must have equal length`,
    );
    process.exit(1);
  }
  for (const file of [...sources, ...targets]) {
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
      console.error(`not a file: ${file}`);
      process.exit(1);
    }
  }
}

/**
 * Unzip a zip file into a same-named directory (minus the .zip extension).
 * Removes the target directory first if it already exists.
 * @param {string} zipPath - path to the zip file
 * @returns {Promise<string>} the extraction directory
 */
async function unzip(zipPath) {
  const dir = zipPath.replace(/\.zip$/, "");
  fs.rmSync(dir, { recursive: true, force: true });
  await execAsync(`unzip -o "${zipPath}" -d "${dir}"`);
  return dir;
}

/**
 * Recursively convert CRLF line endings to LF in all text files under a directory.
 * Skips .git directories and binary files.
 * @param {string} dir - directory to process
 * @returns {Promise<void>}
 */
async function crlfToLf(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === ".git") continue;
      await crlfToLf(fullPath);
    } else if (entry.isFile()) {
      const buf = fs.readFileSync(fullPath);
      if (buf.includes(0)) continue;
      const text = buf.toString("utf-8");
      if (text.includes("\r\n")) {
        fs.writeFileSync(fullPath, text.replace(/\r\n/g, "\n"));
      }
    }
  }
}

/**
 * Prepare a git-based diff between a source and target directory:
 * init + commit in source, move .git into target so `git diff` / `git status`
 * can be run directly inside the target directory.
 * @param {string} sourceDir
 * @param {string} targetDir
 * @returns {Promise<void>}
 */
async function prepareDiff(sourceDir, targetDir) {
  fs.rmSync(path.join(sourceDir, ".git"), { recursive: true, force: true });
  await execAsync("git init -b main", { cwd: sourceDir });
  await crlfToLf(sourceDir);
  await execAsync(
    'git add -A && git -c user.name="diff" -c user.email="diff@local" commit -m "source"',
    { cwd: sourceDir },
  );

  const targetGit = path.join(targetDir, ".git");
  fs.rmSync(targetGit, { recursive: true, force: true });
  fs.renameSync(path.join(sourceDir, ".git"), targetGit);

  await crlfToLf(targetDir);
}

async function main() {
  const { sources, targets } = parseArgs();
  validate(sources, targets);

  const results = await Promise.allSettled(
    sources.map(async (src, i) => {
      const [sourceDir, targetDir] = await Promise.all([
        unzip(src),
        unzip(targets[i]),
      ]);
      await prepareDiff(sourceDir, targetDir);
      console.log(`done: ${targetDir} — run "git diff" or "git status" inside`);
    }),
  );
  for (const r of results) {
    if (r.status === "rejected") console.error(r.reason);
  }
}

main();

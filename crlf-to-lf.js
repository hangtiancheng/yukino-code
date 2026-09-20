#!/usr/bin/env node
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


/**
 * Converts CRLF line endings to LF for all files that are not ignored by Git
 * within the repository that contains the target directory.
 *
 * Usage:
 *   node git-crlf-to-lf.mjs [directory]
 *
 * If `directory` is omitted, the current working directory is used.
 * The script walks upward to locate the owning Git repository. If none is
 * found, it exits with code 1.
 */

import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { access, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

/**
 * @typedef {object} ExecResult
 * @property {string} stdout
 * @property {string} stderr
 */

/**
 * Runs a Git command and returns its stdout/stderr as strings.
 *
 * @param {string} cwd - Working directory for the Git process.
 * @param {string[]} args - Arguments to pass to `git`.
 * @returns {Promise<ExecResult>}
 */
async function execGit(cwd, args) {
  return new Promise((resolve, reject) => {
    const proc = spawn('git', args, { cwd });
    let stdout = '';
    let stderr = '';

    proc.stdout.setEncoding('utf8');
    proc.stderr.setEncoding('utf8');

    proc.stdout.on('data', (chunk) => {
      stdout += chunk;
    });

    proc.stderr.on('data', (chunk) => {
      stderr += chunk;
    });

    proc.on('error', (err) => {
      reject(err);
    });

    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`git ${args.join(' ')} failed with code ${code}: ${stderr.trim() || stdout.trim()}`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

/**
 * Locates the Git repository root that owns the given directory.
 *
 * @param {string} cwd - Directory to start searching from.
 * @returns {Promise<string | null>} Absolute path to the repository root, or `null` if not found.
 */
async function findGitRoot(cwd) {
  try {
    const { stdout } = await execGit(cwd, ['rev-parse', '--show-toplevel']);
    return stdout.trim();
  } catch {
    return null;
  }
}

/**
 * Parses a NUL-delimited Git output string into non-empty lines.
 *
 * @param {string} output - Raw output from a Git command that uses the `-z` flag.
 * @returns {string[]} Individual entries.
 */
function parseNullDelimited(output) {
  return output.split('\0').filter((entry) => entry.length > 0);
}

/**
 * Returns absolute paths of all tracked files in the repository.
 *
 * @param {string} repoRoot - Absolute path to the Git repository root.
 * @returns {Promise<string[]>}
 */
async function getTrackedFiles(repoRoot) {
  const { stdout } = await execGit(repoRoot, ['ls-files', '-z']);
  return parseNullDelimited(stdout).map((relativePath) => path.resolve(repoRoot, relativePath));
}

/**
 * Returns absolute paths of untracked, non-ignored files in the repository.
 *
 * @param {string} repoRoot - Absolute path to the Git repository root.
 * @returns {Promise<string[]>}
 */
async function getUntrackedFiles(repoRoot) {
  const { stdout } = await execGit(repoRoot, ['status', '--porcelain', '--untracked-files=all', '-z']);
  const entries = parseNullDelimited(stdout);
  const files = [];

  for (const entry of entries) {
    // In --porcelain -z output, untracked files are reported as "?? <path>\0".
    if (entry.startsWith('?? ')) {
      const relativePath = entry.slice(3);
      files.push(path.resolve(repoRoot, relativePath));
    }
  }

  return files;
}

/**
 * Heuristic binary-file detection.
 *
 * A buffer is considered binary when it contains at least one NUL byte.
 * This matches Git's default text/binary heuristic for safe line-ending
 * conversion.
 *
 * @param {Buffer} buffer - File contents.
 * @returns {boolean} `true` if the buffer appears to represent a binary file.
 */
function isBinary(buffer) {
  for (let i = 0; i < buffer.length; i += 1) {
    if (buffer[i] === 0x00) {
      return true;
    }
  }
  return false;
}

/**
 * Atomically converts CRLF to LF in a single file and returns whether a change
 * was written.
 *
 * The conversion is performed in-place, but a temporary file is used to avoid
 * corrupting the original if the process is interrupted.
 *
 * @param {string} filePath - Absolute path to the file to process.
 * @returns {Promise<boolean>} `true` if the file was modified, `false` otherwise.
 */
async function convertFile(filePath) {
  const stats = await stat(filePath);
  if (!stats.isFile()) {
    return false;
  }

  const content = await readFile(filePath);

  if (isBinary(content)) {
    return false;
  }

  // Fast path: skip files that contain no CRLF sequences.
  if (!content.includes('\r\n')) {
    return false;
  }

  const converted = content.toString('utf8').replace(/\r\n/g, '\n');
  const tempPath = `${filePath}.tmp-crlf-fix-${Date.now()}`;

  await writeFile(tempPath, converted, 'utf8');
  await pipeline(createReadStream(tempPath), createWriteStream(filePath));
  await unlink(tempPath);

  return true;
}

/**
 * Main entry point.
 *
 * @returns {Promise<void>}
 */
async function main() {
  const targetDirectory = path.resolve(process.argv[2] || process.cwd());

  try {
    await access(targetDirectory);
  } catch {
    console.error(`Error: directory does not exist: ${targetDirectory}`);
    process.exit(1);
  }

  const repoRoot = await findGitRoot(targetDirectory);
  if (!repoRoot) {
    console.error(`Error: no Git repository found for ${targetDirectory}`);
    process.exit(1);
  }

  console.log(`Git repository root: ${repoRoot}`);

  const [trackedFiles, untrackedFiles] = await Promise.all([
    getTrackedFiles(repoRoot),
    getUntrackedFiles(repoRoot),
  ]);

  const fileSet = new Set([...trackedFiles, ...untrackedFiles]);
  const files = Array.from(fileSet).sort();

  if (files.length === 0) {
    console.log('No files to process.');
    return;
  }

  let scanned = 0;
  let converted = 0;
  let skipped = 0;
  const errors = [];

  for (const filePath of files) {
    scanned += 1;

    try {
      const didConvert = await convertFile(filePath);
      if (didConvert) {
        converted += 1;
        console.log(`converted: ${path.relative(repoRoot, filePath)}`);
      } else {
        skipped += 1;
      }
    } catch (err) {
      errors.push({ file: filePath, error: err instanceof Error ? err.message : String(err) });
    }
  }

  console.log(`\nDone. Scanned ${scanned}, converted ${converted}, skipped ${skipped}, errors ${errors.length}`);

  if (errors.length > 0) {
    console.error('\nErrors:');
    for (const { file, error } of errors) {
      console.error(`  ${path.relative(repoRoot, file)}: ${error}`);
    }
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});

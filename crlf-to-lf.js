#!/usr/bin/env node


import { spawn } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { access, readFile, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";


async function execGit(cwd, args) {
  return new Promise((resolve, reject) => {
    const proc = spawn("git", args, { cwd });
    let stdout = "";
    let stderr = "";

    proc.stdout.setEncoding("utf8");
    proc.stderr.setEncoding("utf8");

    proc.stdout.on("data", (chunk) => {
      stdout += chunk;
    });

    proc.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    proc.on("error", (err) => {
      reject(err);
    });

    proc.on("close", (code) => {
      if (code !== 0) {
        reject(
          new Error(
            `git ${args.join(" ")} failed with code ${code}: ${stderr.trim() || stdout.trim()}`,
          ),
        );
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

async function findGitRoot(cwd) {
  try {
    const { stdout } = await execGit(cwd, ["rev-parse", "--show-toplevel"]);
    return stdout.trim();
  } catch {
    return null;
  }
}

function parseNullDelimited(output) {
  return output.split("\0").filter((entry) => entry.length > 0);
}

async function getTrackedFiles(repoRoot) {
  const { stdout } = await execGit(repoRoot, ["ls-files", "-z"]);
  return parseNullDelimited(stdout).map((relativePath) =>
    path.resolve(repoRoot, relativePath),
  );
}

async function getUntrackedFiles(repoRoot) {
  const { stdout } = await execGit(repoRoot, [
    "status",
    "--porcelain",
    "--untracked-files=all",
    "-z",
  ]);
  const entries = parseNullDelimited(stdout);
  const files = [];

  for (const entry of entries) {
    if (entry.startsWith("?? ")) {
      const relativePath = entry.slice(3);
      files.push(path.resolve(repoRoot, relativePath));
    }
  }

  return files;
}

function isBinary(buffer) {
  for (let i = 0; i < buffer.length; i += 1) {
    if (buffer[i] === 0x00) {
      return true;
    }
  }
  return false;
}

async function convertFile(filePath) {
  const stats = await stat(filePath);
  if (!stats.isFile()) {
    return false;
  }

  const content = await readFile(filePath);

  if (isBinary(content)) {
    return false;
  }

  if (!content.includes("\r\n")) {
    return false;
  }

  const converted = content.toString("utf8").replace(/\r\n/g, "\n");
  const tempPath = `${filePath}.tmp-crlf-fix-${Date.now()}`;

  await writeFile(tempPath, converted, "utf8");
  await pipeline(createReadStream(tempPath), createWriteStream(filePath));
  await unlink(tempPath);

  return true;
}

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
    console.log("No files to process.");
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
      errors.push({
        file: filePath,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  console.log(
    `\nDone. Scanned ${scanned}, converted ${converted}, skipped ${skipped}, errors ${errors.length}`,
  );

  if (errors.length > 0) {
    console.error("\nErrors:");
    for (const { file, error } of errors) {
      console.error(`  ${path.relative(repoRoot, file)}: ${error}`);
    }
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(
    `Unexpected error: ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(1);
});

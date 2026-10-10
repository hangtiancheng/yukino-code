import { exec } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";

const execAsync = promisify(exec);

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

async function unzip(zipPath) {
  const dir = zipPath.replace(/\.zip$/, "");
  fs.rmSync(dir, { recursive: true, force: true });
  await execAsync(`unzip -o "${zipPath}" -d "${dir}"`);
  return dir;
}

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

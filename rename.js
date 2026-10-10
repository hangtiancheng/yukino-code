"use strict";


import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const FALLBACK_IGNORED_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  "env",
  "dist",
  "build",
  ".next",
  ".turbo",
  ".cache",
]);




function applyLiteral(name, rules) {
  let newName = name;
  for (const [source, target] of rules) {
    if (!source) continue;
    newName = newName.replaceAll(source, target);
  }
  return newName;
}

function applyRegex(name, compiled) {
  let newName = name;
  for (const [pattern, target] of compiled) {
    newName = newName.replace(pattern, target);
  }
  return newName;
}


function isGitRepo(root) {
  const result = spawnSync(
    "git",
    ["-C", root, "rev-parse", "--is-inside-work-tree"],
    {
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  return (
    result.status === 0 &&
    (result.stdout ?? Buffer.alloc(0)).toString().trim() === "true"
  );
}

function gitIgnored(root, candidates) {
  if (candidates.length === 0) return new Set();

  const stdin = candidates.join("\x00");
  const result = spawnSync(
    "git",
    ["-C", root, "check-ignore", "--stdin", "-z"],
    {
      input: stdin,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );

  if (result.status !== 0 && result.status !== 1) return new Set();
  const output = (result.stdout ?? Buffer.alloc(0)).toString();
  const ignored = new Set(output.split("\x00").filter(Boolean));
  return ignored;
}

function isUnder(p, ancestors) {
  return ancestors.some((a) => p === a || p.startsWith(a + path.sep));
}


function collectPaths(root, respectGitignore) {
  const allPaths = walkRecursive(root);

  if (respectGitignore && isGitRepo(root)) {
    const ignored = gitIgnored(root, allPaths);
    for (const p of allPaths) {
      if (path.basename(p) === ".git" && fs.statSync(p).isDirectory()) {
        ignored.add(p);
      }
    }
    const ignoredDirs = [...ignored].filter((p) => {
      try {
        return fs.statSync(p).isDirectory();
      } catch {
        return false;
      }
    });
    const kept = allPaths.filter(
      (p) => !ignored.has(p) && !isUnder(p, ignoredDirs),
    );
    return kept.sort((a, b) => b.length - a.length);
  }

  const kept = allPaths.filter((p) => {
    const relative = path.relative(root, p);
    const parts = relative.split(path.sep);
    return !parts.some((part) => FALLBACK_IGNORED_DIRS.has(part));
  });
  return kept.sort((a, b) => b.length - a.length);
}

function walkRecursive(dir) {
  const results = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    results.push(fullPath);
    if (entry.isDirectory()) {
      results.push(...walkRecursive(fullPath));
    }
  }
  return results;
}


function buildPlans(paths, rules, regex) {
  const compiled = regex
    ? rules.map(([src, dst]) => [new RegExp(src), dst])
    : [];

  const plans = [];
  for (const src of paths) {
    const baseName = path.basename(src);
    const newName = regex
      ? applyRegex(baseName, compiled)
      : applyLiteral(baseName, rules);
    if (newName === baseName || !newName) continue;
    plans.push({ src, dst: path.join(path.dirname(src), newName) });
  }
  return plans;
}

function execute(plans, dryRun) {
  let succeeded = 0;
  let skipped = 0;
  for (const plan of plans) {
    if (fs.existsSync(plan.dst)) {
      console.error(`[SKIP] target exists: ${plan.src} -> ${plan.dst}`);
      skipped++;
      continue;
    }
    console.log(`[${dryRun ? "DRY" : "OK "}] ${plan.src} -> ${plan.dst}`);
    if (!dryRun) fs.renameSync(plan.src, plan.dst);
    succeeded++;
  }
  return [succeeded, skipped];
}


function renamePaths(rules, options = {}) {
  const rootPath = path.resolve(options.root ?? ".");
  if (!fs.existsSync(rootPath) || !fs.statSync(rootPath).isDirectory()) {
    throw new Error(`root is not a directory: ${rootPath}`);
  }

  const paths = collectPaths(rootPath, options.respectGitignore ?? true);
  const plans = buildPlans(paths, rules, options.regex ?? false);
  return execute(plans, options.dryRun ?? true);
}


function parseCliRules(raw) {
  const rules = [];
  for (const item of raw) {
    if (!item.includes("=>")) {
      throw new Error(`invalid rule (expected SOURCE=>TARGET): '${item}'`);
    }
    const [source, target] = item.split("=>", 2);
    rules.push([source, target]);
  }
  return rules;
}


function parseCliArgs(argv) {
  const args = argv.slice(2);
  const ruleArgs = [];
  const result = {
    rules: [],
    root: ".",
    apply: false,
    regex: false,
    noGitignore: false,
  };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--root") {
      result.root = args[++i] ?? ".";
    } else if (args[i] === "--apply") {
      result.apply = true;
    } else if (args[i] === "--regex") {
      result.regex = true;
    } else if (args[i] === "--no-gitignore") {
      result.noGitignore = true;
    } else if (!args[i].startsWith("--")) {
      ruleArgs.push(args[i]);
    }
  }

  result.rules = parseCliRules(ruleArgs);
  return result;
}

function main(argv) {
  const cli = parseCliArgs(argv);
  if (cli.rules.length === 0) {
    console.log(
      'Usage: node scripts/rename.js "SOURCE=>TARGET" [...] [options]\n\n' +
        "Options:\n" +
        "  --root <dir>      Directory to scan (default: .)\n" +
        "  --apply           Actually rename (default: dry-run)\n" +
        "  --regex           Treat rules as regex substitutions\n" +
        "  --no-gitignore    Do not skip git-ignored paths\n\n" +
        "Examples:\n" +
        '  node scripts/rename.js "foo=>bar" --apply\n' +
        '  node scripts/rename.js "old_name=>new_name" --root ./src --apply',
    );
    return 1;
  }
  const [renamed, skipped] = renamePaths(cli.rules, {
    root: cli.root,
    dryRun: !cli.apply,
    regex: cli.regex,
    respectGitignore: !cli.noGitignore,
  });
  console.log(
    `\nDone. renamed=${renamed}, skipped=${skipped}, dry_run=${!cli.apply}`,
  );
  return 0;
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  process.exit(main(process.argv));
}

export {
  applyLiteral,
  applyRegex,
  isGitRepo,
  gitIgnored,
  isUnder,
  collectPaths,
  buildPlans,
  execute,
  renamePaths,
  parseCliRules,
  parseCliArgs,
  main,
};

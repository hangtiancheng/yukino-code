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

// @ts-check
"use strict";

/**
 * Tag and publish Go modules in a monorepo.
 *
 * When called with no arguments, reads the version field from package.json
 * and tags every module with that version.
 *
 * Library usage:
 *     import { main } from './tag.js';
 *     main({ cache: 'v0.1.0', rpc: 'v0.2.0' });
 *     main();  // uses package.json version for all modules
 *
 * CLI usage:
 *     node tag.js                          # tag all modules with package.json version
 *     node tag.js --cache=v0.1.0           # tag only yukino_cache
 *     node tag.js --cache=v0.1.0 --rpc=v0.2.0
 */

import fs from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** @type {string} */
const ROOT_DIR = path.dirname(fileURLToPath(import.meta.url));

/** @type {Record<string, string>} */
const MODULES = {
  yukino: "yukino",
};

/**
 * Run a command synchronously, throwing on non-zero exit.
 * @param {string[]} command
 */
function run(command) {
  console.log(`> ${command.join(" ")}`);
  const result = spawnSync(command[0], command.slice(1), { stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(
      `Command failed: ${command.join(" ")} (exit ${result.status ?? "?"})`,
    );
  }
}

/**
 * Ensure the version string has a "v" prefix.
 * "1.0.0" -> "v1.0.0", "v1.0.0" -> "v1.0.0".
 * @param {string} ver
 * @returns {string}
 */
function normalizeVersion(ver) {
  return ver.startsWith("v") ? ver : `v${ver}`;
}

/**
 * Validate that a version string matches semver (vX.Y.Z).
 * @param {string} ver
 * @returns {boolean}
 */
function isValidVersion(ver) {
  return /^v\d+\.\d+\.\d+/.test(ver);
}

/**
 * Read the version field from package.json, prefixed with "v".
 * @returns {string}
 */
function readPackageVersion() {
  const pkgPath = path.join(ROOT_DIR, "package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
  const ver = /** @type {string} */ (pkg.version);
  if (!ver) {
    throw new Error("package.json does not contain a version field");
  }
  return normalizeVersion(ver);
}

/**
 * @typedef {object} Versions
 * @property {string} [cache] - yukino_cache version tag (e.g. "v0.1.0").
 * @property {string} [http]  - yukino_http version tag.
 * @property {string} [orm]   - yukino_orm version tag.
 * @property {string} [rpc]   - yukino_rpc version tag.
 */

/**
 * Tag and push module versions.
 *
 * When `versions` is omitted or empty, reads package.json and tags every
 * module with that version.
 *
 * @param {Versions} [versions]
 */
function main(versions) {
  /** @type {Versions} */
  let resolved;

  if (!versions || Object.keys(versions).length === 0) {
    const ver = readPackageVersion();
    console.log(`No modules specified, using package.json version: ${ver}\n`);
    resolved = /** @type {Versions} */ (
      Object.fromEntries(Object.keys(MODULES).map((k) => [k, ver]))
    );
  } else {
    resolved = versions;
  }

  /** @type {string[]} */
  const tagged = [];

  for (const [key, mod] of Object.entries(MODULES)) {
    const raw = resolved[/** @type {keyof Versions} */ (key)];
    if (!raw) continue;
    const ver = normalizeVersion(raw);
    if (!isValidVersion(ver)) {
      throw new Error(
        `invalid version for ${key}: "${raw}" (expected [v]X.Y.Z)`,
      );
    }
    const tag = `${mod}/${ver}`;
    run(["git", "tag", tag]);
    run(["git", "push", "origin", tag]);
    tagged.push(tag);
  }

  if (tagged.length === 0) {
    console.log("No modules specified.");
  } else {
    console.log(`\nTagged and pushed: ${tagged.join(", ")}`);
  }
}

/**
 * Parse CLI arguments into a Versions object.
 * Returns an empty object when no arguments are provided (triggers package.json fallback).
 * @param {string[]} argv
 * @returns {Versions}
 */
function parseArgs(argv) {
  const args = argv.slice(2);
  if (args.length === 0) {
    return {};
  }

  /** @type {Versions} */
  const versions = {};
  for (const arg of args) {
    const m = arg.match(/^--(\w+)=(.+)$/);
    if (!m) {
      console.error(`invalid argument: ${arg}`);
      process.exit(1);
    }
    const [, key, ver] = m;
    if (!(key in MODULES)) {
      console.error(
        `unknown module: ${key} (expected: ${Object.keys(MODULES).join(", ")})`,
      );
      process.exit(1);
    }
    versions[/** @type {keyof Versions} */ (key)] = ver;
  }
  return versions;
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  main(parseArgs(process.argv));
}

export {
  main,
  parseArgs,
  normalizeVersion,
  isValidVersion,
  readPackageVersion,
  MODULES,
};

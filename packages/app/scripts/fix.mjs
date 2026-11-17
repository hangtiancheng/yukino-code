#!/usr/bin/env node

/**
 * Fix incorrect electron binary installation
 *
 * Run this when electron fails to start after pnpm install (reports "Electron uninstall"):
 *   node fix.js
 *
 * How it works: downloads the electron zip from npmmirror and extracts it to node_modules/electron/dist
 */

import { execSync } from "child_process";
import {
  existsSync,
  realpathSync,
  readFileSync,
  writeFileSync,
  rmSync,
  mkdirSync,
} from "fs";
import { join, dirname, resolve } from "path";
import { tmpdir, homedir, platform as osPlatform, arch as osArch } from "os";
import { createRequire } from "module";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
/** @type {string} Project root, one level above this script's directory. */
const root = resolve(__dirname, "..");
const require = createRequire(import.meta.url);

const electronDir = join(root, "node_modules/electron");
const { version } = require(join(electronDir, "package.json"));

const platform = osPlatform();
const arch = osArch();
const mirror = "https://npmmirror.com/mirrors/electron/";
const fileName = `electron-v${version}-${platform}-${arch}.zip`;
const url = `${mirror}v${version}/${fileName}`;

// pnpm actual storage path (symlink target)
const realElectronDir = realpathSync(electronDir);
const distDir = join(realElectronDir, "dist");

function getPlatformPath() {
  switch (platform) {
    case "darwin":
      return "Electron.app/Contents/MacOS/Electron";
    case "linux":
      return "electron";
    case "win32":
      return "electron.exe";
    default:
      throw new Error(`Unsupported platform: ${platform}`);
  }
}

function findCachedZip() {
  const cacheDir = join(homedir(), "Library/Caches/electron");
  if (!existsSync(cacheDir)) return null;
  try {
    const result = execSync(`find "${cacheDir}" -name "${fileName}" -type f`, {
      encoding: "utf-8",
    }).trim();
    return result || null;
  } catch {
    return null;
  }
}

console.log(`electron v${version} / ${platform}-${arch}`);
console.log(`Actual path: ${realElectronDir}`);

const existingPath = join(distDir, getPlatformPath());
if (existsSync(existingPath)) {
  // Check if path.txt is clean (no trailing newline)
  const pathTxt = join(realElectronDir, "path.txt");
  if (existsSync(pathTxt)) {
    const content = readFileSync(pathTxt, "utf-8");
    if (content !== getPlatformPath()) {
      writeFileSync(pathTxt, getPlatformPath());
      console.log("Fixed trailing newline in path.txt");
      process.exit(0);
    }
  }
  console.log("electron binary already exists, no fix needed");
  process.exit(0);
}

let zipPath = findCachedZip();

if (!zipPath) {
  console.log(`Cache miss, downloading from ${url}...`);
  zipPath = join(tmpdir(), fileName);
  execSync(`curl -L -o "${zipPath}" "${url}"`, { stdio: "inherit" });
} else {
  console.log(`Using cache: ${zipPath}`);
}

if (existsSync(distDir)) {
  rmSync(distDir, { recursive: true });
}
mkdirSync(distDir, { recursive: true });

console.log("Extracting...");
execSync(`unzip -q "${zipPath}" -d "${distDir}"`, { stdio: "inherit" });

// path.txt must not have trailing newline, otherwise electron-vite path concatenation will break
writeFileSync(join(realElectronDir, "path.txt"), getPlatformPath());
writeFileSync(join(distDir, "version"), version);

console.log("Fix complete");

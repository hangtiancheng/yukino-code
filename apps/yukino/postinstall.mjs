// Download yukino-code-rpc-${os}-${arch}, yukino-code-stdio-${os}-${arch} and
// yukino-code-ws-${os}-${arch} from the fixed GitHub release into ~/.yukino/bin,
// the directory the CLI resolves Go agent-bridge binaries from.
//
// The release tag carries no version: every publish overwrites the same assets,
// so this always fetches the newest bridge build. Failures never block the
// install — the binaries are only needed by the --rpc / --ws / --stdio bridge
// transports, and a missing binary produces a targeted error at that point.

// @ts-check

import {
  chmodSync,
  existsSync,
  mkdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RELEASE_BASE =
  "https://github.com/hangtiancheng/yukino-code/releases/download/binaries";
const TRANSPORTS = ["rpc", "stdio", "ws"];
const BIN_DIR = path.join(homedir(), ".yukino", "bin");

const here = path.dirname(fileURLToPath(import.meta.url));
// Inside the monorepo the developer builds the binaries locally instead
// (pnpm build:yukino); downloading would just overwrite those local builds.
if (existsSync(path.join(here, "..", "..", "release.js"))) {
  console.log(
    "postinstall: inside the yukino-code repo — skipping bridge binary download (run `pnpm build:yukino` to build them into ~/.yukino/bin).",
  );
  process.exit(0);
}

const { platform, arch } = process;
if (
  !["linux", "darwin", "win32"].includes(platform) ||
  !["x64", "arm64"].includes(arch)
) {
  console.warn(
    `postinstall: no prebuilt bridge binaries for ${platform}-${arch} — skipping; the --rpc/--ws/--stdio transports will not be available.`,
  );
  process.exit(0);
}

mkdirSync(BIN_DIR, { recursive: true });

for (const transport of TRANSPORTS) {
  const name = `yukino-code-${transport}-${platform}-${arch}`;
  const dest = path.join(BIN_DIR, name);
  const temporary = `${dest}.part`;
  try {
    const res = await fetch(`${RELEASE_BASE}/${name}`, { redirect: "follow" });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    writeFileSync(temporary, Buffer.from(await res.arrayBuffer()));
    if (platform !== "win32") {
      chmodSync(temporary, 0o755);
    }
    renameSync(temporary, dest);
    console.log(`postinstall: downloaded ${name} -> ${dest}`);
  } catch (err) {
    console.warn(
      `postinstall: could not download ${name} (${err instanceof Error ? err.message : String(err)}); the --${transport} bridge transport will not work until it is available.`,
    );
  } finally {
    // The successful path already renamed the temp file away; only a failed
    // download leaves it behind.
    if (existsSync(temporary)) {
      try {
        unlinkSync(temporary);
      } catch {
        /* best effort */
      }
    }
  }
}

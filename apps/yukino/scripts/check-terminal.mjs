import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const scriptPath = fileURLToPath(import.meta.url);
const marker = "YUKINO_TERMINAL_CHECK:";

function terminalState(...args) {
  const result = spawnSync("stty", args, {
    stdio: ["inherit", "pipe", "inherit"],
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `stty ${args.join(" ")} failed`);
  return result.stdout.trim();
}

function normalizedState() {
  // PENDIN is a transient kernel reprint flag rather than an input mode.
  const state = terminalState("-g");
  const pendin = process.platform === "darwin" ? 0x20000000n : 0x4000n;
  if (state.startsWith("gfmt1:")) {
    return state.replace(
      /lflag=([\da-f]+)/u,
      (_, value) => "lflag=" + (BigInt("0x" + value) & ~pendin).toString(16),
    );
  }
  const fields = state.split(":");
  fields[3] = (BigInt("0x" + fields[3]) & ~pendin).toString(16);
  return fields.join(":");
}

async function session(binary) {
  terminalState("rows", "24", "cols", "80");
  const original = normalizedState();
  const child = spawn(binary, [], { stdio: "inherit" });
  const resize = () => {
    terminalState("rows", "16", "cols", "60");
    child.kill("SIGWINCH");
  };
  process.on("SIGUSR2", resize);
  process.stdout.write(
    `${marker}${JSON.stringify({ pid: process.pid, child_pid: child.pid })}\n`,
  );
  try {
    const code = await new Promise((done, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => done(code));
    });
    const restored = normalizedState();
    process.stdout.write(
      `${marker}${JSON.stringify({
        exit_code: code,
        raw_mode_restored: original === restored,
        terminal_differences: original === restored ? [] : [original, restored],
      })}\n`,
    );
  } finally {
    process.off("SIGUSR2", resize);
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
  }
}

function shellQuote(value) {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}

async function checkTerminal(
  binary,
  mode,
  report,
  accent,
  withProvider = false,
) {
  const taskHome = mkdtempSync(join(tmpdir(), "yukino-terminal-"));
  mkdirSync(join(taskHome, ".yukino"));
  writeFileSync(
    join(taskHome, ".yukino/config.yaml"),
    (withProvider
      ? "providers:\n  - name: terminal-test\n    protocol: anthropic\n    base_url: http://127.0.0.1:1\n    model: terminal-test\n    api_key: test\n"
      : "providers: []\n") + "theme: auto\nenable_memory: false\n",
  );
  const env = {
    ...process.env,
    HOME: taskHome,
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    HTTP_PROXY: "http://127.0.0.1:1",
    HTTPS_PROXY: "http://127.0.0.1:1",
  };
  delete env.COLORFGBG;
  delete env.NO_COLOR;
  const command = [process.execPath, scriptPath, "--session", binary];
  const args =
    process.platform === "darwin"
      ? ["-q", "/dev/null", ...command]
      : ["-qefc", command.map(shellQuote).join(" "), "/dev/null"];
  // macOS script rejects Node's socket-backed stdin; cat supplies a pipe.
  const child =
    process.platform === "darwin"
      ? spawn(
          "sh",
          ["-c", 'cat | exec "$@"', "terminal-check", "script", ...args],
          {
            cwd: taskHome,
            env,
            stdio: "pipe",
          },
        )
      : spawn("script", args, { cwd: taskHome, env, stdio: "pipe" });
  let output = "";
  let failure;
  let finished = false;
  child.stdout.on("data", (data) => {
    const text = data.toString();
    output += text;
    if (/YUKINO_TERMINAL_CHECK:\{[^\r\n]*"exit_code"/u.test(output))
      child.stdin.end();
    if (text.includes("\x1b[6n")) {
      const background = mode === "light" ? "ffff/ffff/ffff" : "1e1e/1e1e/2e2e";
      child.stdin.write(`\x1b]11;rgb:${background}\x1b\\\x1b[1;1R`);
    }
  });
  child.stderr.on("data", (data) => {
    output += data.toString();
  });
  const completion = new Promise((done) => {
    child.once("error", (error) => {
      failure = error;
      finished = true;
      done();
    });
    child.once("close", () => {
      finished = true;
      done();
    });
  });
  const waitUntil = async (predicate, milliseconds) => {
    const deadline = performance.now() + milliseconds;
    while (!predicate() && !finished && performance.now() < deadline)
      await delay(10);
    if (failure) throw failure;
  };
  const reports = () =>
    [...output.matchAll(/YUKINO_TERMINAL_CHECK:(\{[^\r\n]*\})/gu)].map(
      (match) => JSON.parse(match[1]),
    );
  try {
    await waitUntil(() => output.includes("\x1b[?996n"), 3000);
    const queried = output.includes("\x1b[?996n");
    child.stdin.write(report);
    await delay(500);
    child.stdin.write("\x1b[200~hello\x1b[201~");
    await delay(150);
    const pid = reports().find((entry) => entry.pid)?.pid;
    assert.ok(pid, `PTY harness did not start: ${output}`);
    process.kill(pid, "SIGUSR2");
    await delay(100);
    child.stdin.write("\x03");
    await delay(100);
    child.stdin.write("\x03");
    await waitUntil(() => finished, 3500);
    assert.ok(finished, "Terminal did not exit");
    await completion;
    return {
      mode,
      query_sent: queried,
      palette_seen: output.includes("38;2;" + accent),
      ...reports().find((entry) => "exit_code" in entry),
      summary_seen: output.includes("Session") && output.includes("--resume"),
      native_bar_seen: output.split("\x1b[6 q").length - 1 >= 3,
      cursor_shape_restored:
        output.lastIndexOf("\x1b[0 q") > output.lastIndexOf("\x1b[6 q"),
      cursor_markers_leaked:
        output.includes("yukino-cursor;") || output.includes("yukino-caret"),
    };
  } finally {
    if (!finished) {
      const harness = reports().find((entry) => entry.pid);
      for (const pid of [harness?.child_pid, harness?.pid]) {
        if (pid) {
          try {
            process.kill(pid, "SIGKILL");
          } catch (error) {
            if (error.code !== "ESRCH") throw error;
          }
        }
      }
      child.kill("SIGKILL");
      await completion;
    }
    rmSync(taskHome, { recursive: true, force: true });
  }
}

try {
  if (process.argv[2] === "--session") {
    await session(resolve(process.argv[3]));
  } else {
    assert.equal(
      process.argv.length,
      3,
      "Usage: node scripts/check-terminal.mjs <binary>",
    );
    const binary = resolve(process.argv[2]);
    const fixture = JSON.parse(
      readFileSync(
        join(
          dirname(scriptPath),
          "../internal/ui/testdata/theme-expected.json",
        ),
        "utf8",
      ),
    );
    const accent = (mode) =>
      [1, 3, 5]
        .map((offset) =>
          parseInt(fixture.palettes[mode].accent.slice(offset, offset + 2), 16),
        )
        .join(";");
    const results = [];
    for (const [mode, report, withProvider = false] of [
      ["light", "\x1b[?997;2n"],
      ["dark", "\x1b]11;rgb:1e1e/1e1e/2e2e\x1b\\"],
      ["composer-dark", "\x1b]11;rgb:1e1e/1e1e/2e2e\x1b\\", true],
    ]) {
      results.push(
        await checkTerminal(
          binary,
          mode,
          report,
          accent(mode === "composer-dark" ? "dark" : mode),
          withProvider,
        ),
      );
    }
    console.log(JSON.stringify(results));
    assert.ok(
      results.every(
        (r) =>
          r.query_sent &&
          r.palette_seen &&
          r.exit_code === 0 &&
          r.raw_mode_restored &&
          r.summary_seen &&
          r.native_bar_seen &&
          r.cursor_shape_restored &&
          !r.cursor_markers_leaked,
      ),
    );
  }
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}

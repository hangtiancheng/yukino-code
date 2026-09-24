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

// Helper for recover.test.ts: exercises the real recover() handlers in a child
// process so process.exit() and the crash.log write are observed for real rather
// than mocked. Spawned with cwd set to a temp directory that receives crash.log.
//
// Usage: tsx recover-terminal-script.ts <uncaught|stdio|other>
import { recover } from "@/recover.js";

const mode = process.argv[2] ?? "uncaught";

recover();

// The exact failure recorded in .yukino/crash.log: an asynchronous stdout write
// completing after the terminal (window, or the editor hosting it) went away.
const terminalGone = Object.assign(new Error("write EIO"), {
  code: "EIO",
  syscall: "write",
  errno: -5,
});

switch (mode) {
  case "stdio":
    // The stream-level path: stdout reports the dead terminal itself.
    process.stdout.emit("error", terminalGone);
    break;
  case "other":
    // Control: a genuine bug must still be reported as a crash.
    process.emit("uncaughtException", new Error("real bug"));
    break;
  default:
    process.emit("uncaughtException", terminalGone);
    break;
}

// Reaching this line means the handler neither exited nor threw.
process.exitCode = 2;

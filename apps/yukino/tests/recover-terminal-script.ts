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

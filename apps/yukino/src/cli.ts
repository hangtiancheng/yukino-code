import { handleUpdateCommand } from "./update/index.js";

if (!(await handleUpdateCommand(process.argv.slice(2)))) {
  const { runCli } = await import("./main.js");
  await runCli();
}

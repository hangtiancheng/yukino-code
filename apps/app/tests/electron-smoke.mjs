import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { _electron } from "@playwright/test";

const fixture = await mkdtemp(join(tmpdir(), "yukino-desktop-smoke-"));
const project = join(fixture, "project");
const userData = join(fixture, "profile");
await mkdir(project);
await mkdir(userData);
await writeFile(join(project, "hello.ts"), "export const value = 1;\n");
await writeFile(
  join(userData, "state.json"),
  JSON.stringify({ cwd: project, theme: "light" }),
);
const launcher = join(fixture, "main.cjs");
await writeFile(
  launcher,
  `const {app}=require("electron"); app.setPath("userData", ${JSON.stringify(userData)}); require(${JSON.stringify(resolve("out/main/index.js"))});`,
);
let desktop;
try {
  desktop = await _electron.launch({
    args: [...(process.getuid?.() === 0 ? ["--no-sandbox"] : []), launcher],
    timeout: 30000,
  });
  const page = await desktop.firstWindow();
  await page.waitForFunction(() => Boolean(window.api), { timeout: 15000 });
  const agent = await page.evaluate(() => window.api.init());
  const initial = await page.evaluate(() =>
    window.api.workspaceRead("hello.ts"),
  );
  assert.equal(initial.content, "export const value = 1;\n");
  const saved = await page.evaluate(
    (file) =>
      window.api.workspaceSave(
        file.path,
        "export const value = 2;\n",
        file.revision,
      ),
    initial,
  );
  assert.equal(saved.content, "export const value = 2;\n");
  assert.equal(
    await readFile(join(project, "hello.ts"), "utf8"),
    saved.content,
  );
  const traversal = await page.evaluate(() =>
    window.api.workspaceRead("../profile/state.json").then(
      () => false,
      () => true,
    ),
  );
  assert.equal(traversal, true);
  await writeFile(join(project, "hello.ts"), "export const value = 3;\n");
  const stale = await page.evaluate(
    (file) =>
      window.api.workspaceSave(file.path, "stale draft", file.revision).then(
        () => false,
        () => true,
      ),
    saved,
  );
  assert.equal(stale, true);
  if (agent.ok) {
    await page
      .locator(".monaco-editor")
      .first()
      .waitFor({ state: "visible", timeout: 15000 });
  }
  await page.screenshot({
    path: "test-results/electron-desktop.png",
    animations: "disabled",
  });
} finally {
  try {
    if (desktop) {
      const child = desktop.process();
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
      }, 10000);
      try {
        await desktop.close();
        assert.equal(
          child.exitCode,
          0,
          "Electron must exit gracefully after cleanup",
        );
      } finally {
        clearTimeout(timer);
      }
    }
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
}
console.log(
  "Electron smoke passed: preload IPC, file reads/writes, traversal rejection, save conflict and graceful shutdown.",
);

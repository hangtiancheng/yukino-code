import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { _electron, type ElectronApplication } from "@playwright/test";

async function run(): Promise<void> {
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
  let desktop: ElectronApplication | undefined;
  try {
    desktop = await _electron.launch({
      env: { ...process.env, YUKINO_LOG_LEVEL: "debug" },
      args: [...(process.getuid?.() === 0 ? ["--no-sandbox"] : []), launcher],
      timeout: 30_000,
    });
    const page = await desktop.firstWindow();
    await page.waitForFunction(() => Boolean(window.api), { timeout: 15_000 });
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
    await page.evaluate(() => {
      console.warn("Smoke renderer warning token=smoke-credential");
    });
    await desktop.evaluate(({ app, shell }) => {
      shell.openPath = async (path) => {
        if (path !== app.getPath("logs")) {
          throw new Error("Open logs must use the application log directory");
        }
        return "";
      };
    });
    await page.evaluate(() => window.api.openLogs());
    if (agent.ok) {
      await page
        .locator(".monaco-editor")
        .first()
        .waitFor({ state: "visible", timeout: 15_000 });
    }
    await page.screenshot({
      path: "test-results/electron-desktop.png",
      animations: "disabled",
    });
    await desktop.close();
    desktop = undefined;
    const logDirectory = join(userData, "logs");
    const logFiles = (await readdir(logDirectory)).filter((name) =>
      name.endsWith(".jsonl"),
    );
    assert.equal(logFiles.length, 1);
    const logs = await readFile(join(logDirectory, logFiles[0]), "utf8");
    assert.match(logs, /Application starting/);
    assert.match(logs, /Application stopped/);
    assert.match(logs, /IPC request failed/);
    assert.match(logs, /workspace:read/);
    assert.match(logs, /yukino:open-logs/);
    assert.match(logs, /Smoke renderer warning/);
    assert.match(logs, /\[Redacted\]/);
    assert.doesNotMatch(
      logs,
      /smoke-credential|stale draft|export const value/,
    );
    const missing = join(
      fixture,
      "TestExecutorContextMappingPersistence-deleted",
    );
    await writeFile(
      join(userData, "state.json"),
      JSON.stringify({ cwd: missing, theme: "light" }),
    );
    desktop = await _electron.launch({
      args: [...(process.getuid?.() === 0 ? ["--no-sandbox"] : []), launcher],
      timeout: 30_000,
    });
    const recovery = await desktop.firstWindow();
    await recovery.waitForFunction(() => Boolean(window.api));
    const failures = await recovery.evaluate(() =>
      Promise.all([window.api.init(), window.api.init()]),
    );
    for (const failure of failures) {
      assert.ok(!failure.ok);
      assert.equal(failure.kind, "project");
      assert.doesNotMatch(failure.error, /ENOENT|lstat/);
      assert.equal(failure.details, missing);
    }
    await recovery
      .getByRole("heading", { name: "Unable to open project" })
      .waitFor();
    await recovery.screenshot({
      path: "test-results/electron-project-recovery.png",
      animations: "disabled",
    });
    await desktop.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [path],
      });
    }, project);
    const selected = await recovery.evaluate(() => window.api.selectFolder());
    assert.equal(selected.cwd, project);
    const recovered = await recovery.evaluate(() =>
      window.api.workspaceRead("hello.ts"),
    );
    assert.equal(recovered.content, "export const value = 3;\n");
  } finally {
    try {
      if (desktop) {
        const child = desktop.process();
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
        }, 10_000);
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
    "Electron smoke passed: preload IPC, file reads/writes, traversal rejection, save conflict, missing-project recovery, Pino logs, credential redaction and graceful shutdown.",
  );
}

void run().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});

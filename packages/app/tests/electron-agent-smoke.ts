import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { _electron, expect, type ElectronApplication } from "@playwright/test";

async function run(): Promise<void> {
  const fixture = await realpath(
    await mkdtemp(join(tmpdir(), "yukino-native-agent-")),
  );
  const project = join(fixture, "project");
  const profile = join(fixture, "profile");
  const home = join(fixture, "home");
  await mkdir(join(home, ".yukino"), { recursive: true });
  await mkdir(join(project, ".agents", "skills", "native"), {
    recursive: true,
  });
  await mkdir(join(project, ".yukino", "workflows"), { recursive: true });
  await writeFile(
    join(project, ".yukino", "workflows", "fixture.js"),
    'log("Workflow ready"); return args;',
  );
  await writeFile(
    join(project, ".agents", "skills", "native", "SKILL.md"),
    "---\nname: native\ndescription: Native integration fixture\n---\nTest native integration.\n",
  );
  await mkdir(profile);
  await writeFile(
    join(profile, "state.json"),
    JSON.stringify({ cwd: project }),
  );
  let requests = 0;
  const { promise: thirdResponse, resolve: releaseThirdResponse } =
    Promise.withResolvers<undefined>();
  const server = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      const requestNumber = ++requests;
      response.writeHead(200, { "content-type": "text/event-stream" });
      const event = (type: string, data: Record<string, unknown>): void => {
        response.write(
          `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`,
        );
      };
      event("message_start", {
        message: {
          id: `native-${requests}`,
          type: "message",
          role: "assistant",
          content: [],
          model: "native-fixture",
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 5, output_tokens: 0 },
        },
      });
      if (requests === 1) {
        event("content_block_start", {
          index: 0,
          content_block: {
            type: "tool_use",
            id: "native-code",
            name: "CodeMode",
            input: {},
          },
        });
        const code =
          'const results = await Promise.all([tools.Bash({command:"printf native-one"}),tools.Bash({command:"printf native-two"})]); text(results.map((result)=>result.output)); await tools.WriteFile({file_path:"created.ts",content:"export const native = true;\\n"}); text("native-code-complete");';
        event("content_block_delta", {
          index: 0,
          delta: {
            type: "input_json_delta",
            partial_json: JSON.stringify({ code }),
          },
        });
        event("content_block_stop", { index: 0 });
        event("message_delta", {
          delta: { stop_reason: "tool_use", stop_sequence: null },
          usage: { output_tokens: 1 },
        });
      } else {
        event("content_block_start", {
          index: 0,
          content_block: { type: "text", text: "" },
        });
        event("content_block_delta", {
          index: 0,
          delta: { type: "text_delta", text: "Native agent completed." },
        });
        event("content_block_stop", { index: 0 });
        event("message_delta", {
          delta: { stop_reason: "end_turn", stop_sequence: null },
          usage: { output_tokens: 1 },
        });
      }
      const finish = (): void => {
        event("message_stop", {});
        response.end();
      };
      if (requestNumber === 3) {
        void thirdResponse.then(finish);
      } else {
        finish();
      }
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  await writeFile(
    join(home, ".yukino", "config.yaml"),
    `providers:\n  - name: Native fixture\n    protocol: anthropic\n    base_url: http://127.0.0.1:${address.port}\n    api_key: fixture-key\n    model: native-fixture\ncode_mode:\n  mode: on\nenable_memory: false\nsandbox:\n  enabled: false\nshellCommandPrefix: export YUKINO_DESKTOP_SMOKE=ready\n`,
  );
  const launcher = join(fixture, "main.cjs");
  await writeFile(
    launcher,
    `const os=require("node:os"); os.homedir=()=>${JSON.stringify(home)}; require("node:module").syncBuiltinESMExports(); const {app}=require("electron"); app.setPath("userData",${JSON.stringify(profile)}); require(${JSON.stringify(resolve("out/main/index.js"))});`,
  );
  let desktop: ElectronApplication | undefined;
  try {
    desktop = await _electron.launch({
      args: [...(process.getuid?.() === 0 ? ["--no-sandbox"] : []), launcher],
      timeout: 30000,
    });
    const page = await desktop.firstWindow();
    const approval = page.getByRole("dialog", {
      name: "Agent approval",
      exact: true,
    });
    await expect(approval).toBeVisible({ timeout: 20000 });
    await approval.getByRole("button", { name: /^once/ }).click();
    await approval.getByRole("button", { name: "Submit answer" }).click();
    const initialized = await page.evaluate(() => window.api.init());
    assert.ok(initialized.ok);
    await page.evaluate(() => {
      window.api.onEvent((event) => {
        if (event.type === "permission_request") {
          void window.api.respondPermission(event.data.id, "allow");
        }
      });
    });
    await page.evaluate(() =>
      window.api.send("Try CodeMode in the native desktop"),
    );
    const executed = await page.evaluate(
      (id) => window.api.resumeSession(id),
      initialized.sessionId,
    );
    const executedCode = executed.messages
      .flatMap((message) => message.toolResults ?? [])
      .find((result) => result.toolUseId === "native-code");
    assert.equal(executedCode?.isError, false, executedCode?.content);
    assert.equal(requests, 2);
    assert.equal(
      (await readFile(join(project, "created.ts"), "utf8")).includes(
        "native = true",
      ),
      true,
    );
    const created = await page.evaluate(() =>
      window.api.workspaceRead("created.ts"),
    );
    assert.equal(created.baseline, "");
    const fresh = await page.evaluate(() => window.api.newSession());
    assert.notEqual(fresh.sessionId, initialized.sessionId);
    assert.equal(
      (await page.evaluate(() => window.api.getAgentState())).sessionId,
      fresh.sessionId,
    );
    const history = await page.evaluate(
      (id) => window.api.resumeSession(id),
      initialized.sessionId,
    );
    const code = history.messages
      .flatMap((message) => message.toolResults ?? [])
      .find((result) => result.toolUseId === "native-code");
    assert.equal(code?.isError, false);
    assert.match(code?.content ?? "", /native-one/);
    assert.match(code?.content ?? "", /native-two/);
    assert.match(code?.content ?? "", /native-code-complete/);
    await page.evaluate(() =>
      window.api.setPreferences(
        {
          code_mode: { mode: "only", inline_budget: 0 },
          display: { show_thinking: false, expanded_tools: true },
        },
        true,
      ),
    );
    await page.evaluate(() => window.api.reloadResources());
    const state = await page.evaluate(() => window.api.getAgentState());
    assert.equal(state.sessionId, initialized.sessionId);
    assert.equal(state.preferences.values.code_mode.mode, "only");
    assert.equal(state.preferences.values.display.show_thinking, false);
    assert.equal(JSON.stringify(state).includes("fixture-key"), false);
    await page.evaluate(() =>
      window.api.send('! printf "$YUKINO_DESKTOP_SMOKE"'),
    );
    const shell = await page.evaluate(
      (id) => window.api.resumeSession(id),
      initialized.sessionId,
    );
    assert.equal(
      shell.messages.findLast((message) => message.userBash)?.userBash?.output,
      "ready",
    );
    const destination = join(fixture, "session.jsonl");
    await desktop.evaluate(({ dialog }, filePath) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath });
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [filePath],
      });
    }, destination);
    assert.equal(
      await page.evaluate(() =>
        window.api.transferSession("export", {
          format: "jsonl",
          scope: "tree",
          redact: false,
        }),
      ),
      true,
    );
    assert.equal(
      await page.evaluate(() => window.api.transferSession("import")),
      true,
    );
    assert.equal(
      requests,
      2,
      "Session import must not replay CodeMode or contact the provider",
    );
    const imported = await page.evaluate(() => window.api.getAgentState());
    assert.notEqual(imported.sessionId, initialized.sessionId);
    const otherProject = join(fixture, "other-project");
    await mkdir(otherProject);
    await desktop.evaluate(({ dialog }, cwd) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [cwd],
      });
    }, otherProject);
    await page.evaluate(() => window.api.selectFolder());
    const restore = page.evaluate(
      ({ id, cwd }) => window.api.resumeSession(id, cwd),
      { id: initialized.sessionId, cwd: project },
    );
    const trustOnce = page.getByRole("button", { name: /^once/ });
    await Promise.race([
      restore.then(() => undefined),
      trustOnce.waitFor({ state: "visible" }),
    ]);
    if (await trustOnce.isVisible()) {
      await trustOnce.click();
      await page.getByRole("button", { name: "Submit answer" }).click();
    }
    const crossProject = await restore;
    assert.equal(crossProject.sessionId, initialized.sessionId);
    assert.equal(crossProject.cwd, project);
    assert.equal(crossProject.switchedCwd, true);
    assert.equal(
      (await page.evaluate(() => window.api.getAgentState())).sessionId,
      initialized.sessionId,
    );
    assert.equal(
      requests,
      2,
      "Cross-project restore must not execute recorded work",
    );
    const foreground = page.evaluate(() =>
      window.api.send("Pause at the fixture response"),
    );
    void foreground.catch(() => undefined);
    await expect.poll(() => requests).toBe(3);
    await page.evaluate(() =>
      window.api.send("Recall before delivery", "followUp"),
    );
    const queued = await page.evaluate(() => window.api.getAgentState());
    assert.equal(queued.queue.length, 1);
    assert.equal(queued.queue[0].kind, "followUp");
    assert.equal(
      await page.evaluate(
        (id) => window.api.cancelQueuedMessage(id),
        queued.queue[0].id,
      ),
      "Recall before delivery",
    );
    assert.deepEqual(
      (await page.evaluate(() => window.api.getAgentState())).queue,
      [],
    );
    const transcript = page.getByLabel("Conversation messages");
    await page.evaluate(() =>
      window.api.send("Deliver this follow-up", "followUp"),
    );
    await expect(
      page.getByRole("list", { name: "Queued messages" }),
    ).toContainText("Deliver this follow-up");
    await expect(
      transcript.getByText("Deliver this follow-up", { exact: true }),
    ).toHaveCount(0);
    releaseThirdResponse(undefined);
    await foreground;
    assert.equal(
      requests,
      4,
      "Only the active request and the accepted follow-up should reach the provider",
    );
    await expect(
      transcript.getByText("Deliver this follow-up", { exact: true }),
    ).toBeVisible();
    await expect(
      transcript.getByText("Recall before delivery", { exact: true }),
    ).toHaveCount(0);
    assert.ok(
      (await page.evaluate(() => window.api.getAgentState())).attempts.some(
        (attempt) =>
          attempt.model === "native-fixture" && attempt.outcome === "completed",
      ),
    );

    await desktop.evaluate(
      async ({ clipboard, nativeImage, ClipboardItem }) => {
        const image = nativeImage
          .createFromBitmap(Buffer.from([0, 0, 255, 255]), {
            width: 1,
            height: 1,
          })
          .toPNG();
        await clipboard.write([
          new ClipboardItem({
            "image/png": new Blob([new Uint8Array(image)], {
              type: "image/png",
            }),
          }),
        ]);
      },
    );
    const pasted = await page.evaluate(() => window.api.pasteImage());
    assert.equal((await readFile(pasted)).subarray(1, 4).toString(), "PNG");

    assert.deepEqual(
      (await page.evaluate(() => window.api.getRuntime())).namedWorkflows,
      ["fixture"],
    );
    await page.evaluate(() =>
      window.api.controlAgent({
        type: "workflow_run",
        input: { name: "fixture", args: { from: "desktop" } },
      }),
    );
    await expect
      .poll(() =>
        page.evaluate(
          async () =>
            (await window.api.getRuntime()).workflows.find(
              (run) => run.workflowName === "fixture",
            )?.returnValue,
        ),
      )
      .toEqual({ from: "desktop" });
    await page.screenshot({
      path: "test-results/electron-native-agent.png",
      animations: "disabled",
    });
    await desktop.close();
    desktop = undefined;
    desktop = await _electron.launch({
      args: [...(process.getuid?.() === 0 ? ["--no-sandbox"] : []), launcher],
      timeout: 30000,
    });
    const pending = await desktop.firstWindow();
    await expect(
      pending.getByRole("dialog", { name: "Agent approval", exact: true }),
    ).toBeVisible({ timeout: 20000 });
    const child = desktop.process();
    await desktop.close();
    assert.equal(
      child.exitCode,
      0,
      "Closing during a trust request must cancel initialization and exit",
    );
    desktop = undefined;
    console.log(
      "Native Electron agent passed: trust, Code Mode, file history, settings, shell, session transfer, queue recall, clipboard image, and workflow launch.",
    );
  } finally {
    releaseThirdResponse(undefined);
    await desktop?.close();
    await new Promise<void>((done) =>
      server.close(() => {
        done();
      }),
    );
    await rm(fixture, { recursive: true, force: true });
  }
}
void run().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});

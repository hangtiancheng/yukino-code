import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const root = await mkdtemp(join(tmpdir(), "yukino-browser-smoke-"));
const home = join(root, "home");
const project = join(root, "project");
await mkdir(join(home, ".yukino"), { recursive: true });
await mkdir(project);
const checkScrolling = process.argv.includes("--scroll");
let requests = 0;
const provider = createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => {
    body += chunk;
  });
  req.on("end", () => {
    JSON.parse(body);
    requests++;
    res.writeHead(200, { "content-type": "text/event-stream" });
    const chunk = {
      id: `local-${requests}`,
      object: "chat.completion.chunk",
      created: 1,
      model: "local",
      choices: [
        {
          index: 0,
          delta: {
            role: "assistant",
            content: checkScrolling
              ? "LOCAL_BROWSER_OK\n\n" +
                Array.from(
                  { length: 150 },
                  (_, i) => `Long response line ${String(i)}.`,
                ).join("\n\n")
              : "LOCAL_BROWSER_OK",
          },
          finish_reason: null,
        },
      ],
    };
    res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    res.write(
      `data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 } })}\n\n`,
    );
    res.end("data: [DONE]\n\n");
  });
});
provider.listen(0, "127.0.0.1");
await once(provider, "listening");
await writeFile(
  join(home, ".yukino", "config.yaml"),
  JSON.stringify({
    providers: [
      {
        name: "local",
        protocol: "openai-compat",
        base_url: `http://127.0.0.1:${provider.address().port}/v1`,
        model: "local",
        api_key: "local-fixture",
        thinking: "off",
      },
    ],
    enable_memory: false,
    permission_mode: "default",
  }),
);
const entry = fileURLToPath(
  new URL(
    process.argv.includes("--source")
      ? "../../src/cli.ts"
      : "../../dist/main.js",
    import.meta.url,
  ),
);
const app = spawn(
  process.execPath,
  ["--import", import.meta.resolve("tsx"), entry, "--remote", "127.0.0.1:0"],
  {
    cwd: project,
    env: {
      ...process.env,
      TSX_TSCONFIG_PATH: fileURLToPath(
        new URL("../../tsconfig.json", import.meta.url),
      ),
      HOME: home,
      OTEL_SDK_DISABLED: "true",
      SENTRY_DSN: "",
      LANGFUSE_PUBLIC_KEY: "",
      LANGFUSE_SECRET_KEY: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  },
);
let appLog = "";
const url = await new Promise((resolve, reject) => {
  const timer = setTimeout(
    () => reject(new Error(`Remote startup timed out: ${appLog}`)),
    30_000,
  );
  const read = (chunk) => {
    appLog += chunk.toString();
    const match = appLog.match(/Remote server listening at (http:\/\/[^\s]+)/);
    if (match) {
      clearTimeout(timer);
      resolve(match[1]);
    }
  };
  app.stdout.on("data", read);
  app.stderr.on("data", read);
  app.once("exit", (code) => {
    clearTimeout(timer);
    reject(new Error(`Remote exited ${code}: ${appLog}`));
  });
});
const chrome = spawn(
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  [
    "--headless=new",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-extensions",
    "--disable-sync",
    "--remote-debugging-port=0",
    `--user-data-dir=${join(root, "chrome")}`,
    "about:blank",
  ],
  { stdio: ["ignore", "ignore", "pipe"] },
);
let socket;
const errors = [];
let failureEvidence = async () => ({});
const deadline = setTimeout(() => {
  app.kill("SIGTERM");
  chrome.kill("SIGTERM");
}, 60_000);
try {
  const debuggerUrl = await new Promise((resolve, reject) => {
    let log = "";
    chrome.stderr.on("data", (chunk) => {
      log += chunk;
      const match = log.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) resolve(match[1]);
    });
    chrome.once("exit", (code) =>
      reject(new Error(`Chrome exited ${code}: ${log}`)),
    );
  });
  socket = new WebSocket(debuggerUrl);
  await once(socket, "open");
  let sequence = 0;
  const pending = new Map();
  socket.on("message", (bytes) => {
    const message = JSON.parse(bytes.toString());
    if (message.id) {
      const wait = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) wait?.reject(new Error(message.error.message));
      else wait?.resolve(message.result);
    }
    if (message.method === "Runtime.exceptionThrown")
      errors.push(
        message.params.exceptionDetails.exception?.description ??
          message.params.exceptionDetails.text,
      );
  });
  const command = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const id = ++sequence;
      pending.set(id, { resolve, reject });
      socket.send(
        JSON.stringify({
          id,
          method,
          params,
          ...(sessionId ? { sessionId } : {}),
        }),
      );
    });
  const { targetId } = await command("Target.createTarget", {
    url: "about:blank",
  });
  const { sessionId } = await command("Target.attachToTarget", {
    targetId,
    flatten: true,
  });
  const page = (method, params = {}) => command(method, params, sessionId);
  await page("Runtime.enable");
  await page("Page.enable");
  await page("Emulation.setDeviceMetricsOverride", {
    width: 1200,
    height: 850,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await page("Page.navigate", { url });
  const evaluate = async (expression) => {
    const result = await page("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails)
      throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  failureEvidence = async () => {
    const { data } = await page("Page.captureScreenshot", { format: "png" });
    await writeFile(join(root, "failure.png"), Buffer.from(data, "base64"));
    return {
      body: await evaluate("document.documentElement.outerHTML"),
      errors,
      root,
    };
  };
  const waitFor = (condition) =>
    evaluate(
      `new Promise((resolve, reject) => { const test = () => { if (${condition}) { observer.disconnect(); clearTimeout(timer); resolve(true); } }; const observer = new MutationObserver(test); const timer = setTimeout(() => { observer.disconnect(); reject(new Error(document.body.innerText)); }, 15000); observer.observe(document.documentElement, { childList:true, subtree:true, attributes:true, characterData:true }); test(); })`,
    );
  await waitFor('document.querySelector("textarea")');
  const submit = (text) =>
    evaluate(
      `(() => { const input = document.querySelector("textarea"); const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set; setter.call(input, ${JSON.stringify(text)}); input.dispatchEvent(new Event("input", {bubbles:true})); input.dispatchEvent(new KeyboardEvent("keydown", {key:"Enter", code:"Enter", bubbles:true})); return true; })()`,
    );
  await waitFor('document.body.innerText.includes("connected")');
  const composerStyle = await evaluate(`(() => {
    const input = document.querySelector("textarea");
    input.focus();
    const field = getComputedStyle(input.closest(".composer-field"));
    const control = getComputedStyle(input);
    return { outline: field.outlineStyle, border: field.borderTopWidth,
      controlBorder: control.borderTopWidth, controlShadow: control.boxShadow };
  })()`);
  assert.equal(composerStyle.outline, "none");
  assert.equal(composerStyle.border, "1px");
  assert.equal(composerStyle.controlBorder, "0px");
  const { data: composerImage } = await page("Page.captureScreenshot", {
    format: "png",
  });
  await writeFile(
    join(root, "composer.png"),
    Buffer.from(composerImage, "base64"),
  );
  await submit("Verify this local browser session");
  await waitFor('document.body.innerText.includes("LOCAL_BROWSER_OK")');
  await waitFor(
    'document.querySelector("footer [data-slot=collapsible-trigger]")?.innerText.includes("Actual run: 1 requests")',
  );
  await evaluate(
    'document.querySelector("footer [data-slot=collapsible-trigger]").click()',
  );
  await waitFor(
    'document.querySelector("footer pre")?.innerText.includes("Actual session: 1 requests")',
  );
  await submit("/warming stop");
  await waitFor('document.body.innerText.includes("user_stopped")');
  await submit("/name browser-smoke");
  await waitFor('document.body.innerText.includes("browser-smoke")');
  if (checkScrolling) {
    const scrollChecks = await evaluate(`(async () => {
    const viewport = document.querySelector('[role="log"]');
    const settle = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    for(let i=0;i<30;i++) await settle();
    if (viewport.scrollHeight <= viewport.clientHeight) throw new Error('Expected overflowing transcript');
    const initialGap = viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop;
    const initialBottom = viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop < 8;
    viewport.dispatchEvent(new WheelEvent('wheel', {deltaY:-500, bubbles:true}));
    viewport.scrollTop = 0;
    viewport.dispatchEvent(new Event('scroll'));
    await settle();
    const button = document.querySelector('[aria-label="Scroll to the latest message"]');
    if (!button) throw new Error('Missing return-to-bottom button after scrolling up');
    document.querySelector('footer [data-slot=collapsible-trigger]').click();
    await settle();
    if (viewport.scrollTop !== 0) throw new Error('Viewport resize interrupted reading older messages');
    button.click();
    for (let i=0;i<180;i++) {
      await settle();
      if (viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop < 8) return {initialBottom, initialGap, resumed:true};
    }
    throw new Error('Did not resume following the transcript');
  })()`);
    assert.equal(scrollChecks.initialBottom, true);
    assert.equal(scrollChecks.resumed, true);
  }
  await submit("/tree");
  await waitFor(
    'document.querySelector(\'[role="dialog"][aria-label="Session tree"]\')',
  );
  const body = await evaluate("document.body.innerText");
  await writeFile(join(root, "body.txt"), body);
  const { data } = await page("Page.captureScreenshot", { format: "png" });
  const screenshot = join(root, "remote-browser.png");
  await writeFile(screenshot, Buffer.from(data, "base64"));
  assert.equal(requests, 1);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ screenshot, root, requests, body }));
} catch (error) {
  const evidence = await failureEvidence();
  await writeFile(join(root, "failure.json"), JSON.stringify(evidence));
  console.error(JSON.stringify(evidence));
  throw error;
} finally {
  clearTimeout(deadline);
  socket?.close();
  app.kill("SIGTERM");
  chrome.kill("SIGTERM");
  provider.close();
  await writeFile(join(root, "app.log"), appLog);
}

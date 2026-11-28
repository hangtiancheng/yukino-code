import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, mkdir, open, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import WebSocket from "ws";

const root = await mkdtemp(join(tmpdir(), "yukino-offline-viewer-"));
const home = join(root, "home");
await mkdir(home);
process.env.HOME = home;
process.env.YUKINO_TEST_HOME = home;
const {
  createSessionHeader,
  makeArtifact,
  sessionUtf8Chunks,
  validateDocument,
} = await import("../../src/session/records.ts");
const { sessionHtmlParts, renderSessionHtml, SESSION_VIEWER_SCRIPT } =
  await import("../../src/session/transfer.ts");
const { SESSION_EXPORT_CSP, SESSION_TRANSPORT_CHUNK_BYTES } =
  await import("../../src/session/constants.ts");
const attack =
  '<script>globalThis.transcriptExecuted=true;fetch("https://invalid.example/transcript")</script><img src="https://invalid.example/image" onerror="globalThis.transcriptExecuted=true"><a href="javascript:globalThis.transcriptExecuted=true">hostile URL</a>';
const artifact = makeArtifact(Buffer.from(attack), "text/html", 1);
const png = makeArtifact(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1WQAAAAASUVORK5CYII=",
    "base64",
  ),
  "image/png",
  2,
);
const entry = (entryId, parentId, message, revision) => ({
  type: "message",
  entryId,
  parentId,
  message: { ...message, timestamp: 1 },
  revision,
  timestamp: 1,
});
const document = validateDocument(createSessionHeader(), [
  artifact,
  png,
  entry(
    "root",
    null,
    { role: "user", content: `${attack}\n${"雪🙂<&>".repeat(120_000)}` },
    3,
  ),
  entry(
    "old",
    "root",
    {
      role: "assistant",
      content: "historical branch",
      historical: true,
      cost: { amount: 1, currency: "USD" },
    },
    4,
  ),
  entry(
    "new",
    "root",
    {
      role: "assistant",
      content: "```diff\n@@ branch\n-old branch\n+new branch\n```",
      cost: { amount: 2, currency: "USD" },
    },
    5,
  ),
  entry(
    "schema",
    "new",
    {
      role: "system",
      type: "session_runtime_state",
      content: "",
      state: {
        provider: {
          name: "local",
          model: "local",
          protocol: "openai",
          endpointFingerprint: "a".repeat(64),
        },
        thinking: "off",
        tools: [],
        discovered: [],
      },
    },
    6,
  ),
  {
    type: "label",
    entryId: "new",
    label: "<script>globalThis.transcriptExecuted=true</script> branch",
    revision: 7,
  },
  {
    type: "metadata",
    metadata: {
      name: "</title><script>globalThis.transcriptExecuted=true</script>",
    },
    revision: 8,
  },
  { type: "active_leaf", leafId: "schema", revision: 9 },
]);
assert.throws(() => renderSessionHtml(document), /string byte limit/);
const htmlPath = join(root, "offline-session.html");
const file = await open(htmlPath, "wx", 0o600);
let htmlBytes = 0;
let chunks = 0;
let largestChunk = 0;
try {
  for (const chunk of sessionUtf8Chunks(sessionHtmlParts(document))) {
    assert.ok(chunk.byteLength <= SESSION_TRANSPORT_CHUNK_BYTES);
    largestChunk = Math.max(largestChunk, chunk.byteLength);
    htmlBytes += chunk.byteLength;
    chunks++;
    await file.writeFile(chunk);
  }
} finally {
  await file.close();
}
assert.ok(htmlBytes > 1024 * 1024);
const hash = createHash("sha256")
  .update(SESSION_VIEWER_SCRIPT)
  .digest("base64");
assert.ok(SESSION_EXPORT_CSP.includes(`script-src 'sha256-${hash}'`));
const chrome = spawn(
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  [
    "--headless=new",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-extensions",
    "--disable-sync",
    "--disable-default-apps",
    "--metrics-recording-only",
    "--host-resolver-rules=MAP * ~NOTFOUND",
    "--remote-debugging-port=0",
    `--user-data-dir=${join(root, "chrome")}`,
    "about:blank",
  ],
  {
    env: { HOME: home, PATH: "/usr/bin:/bin", TMPDIR: root },
    stdio: ["ignore", "ignore", "pipe"],
  },
);
const deadline = setTimeout(() => chrome.kill("SIGTERM"), 60_000);
let socket;
const requests = [];
const blockedRequests = [];
const exceptions = [];
let browserVersion;
try {
  const debuggerUrl = await new Promise((resolve, reject) => {
    let log = "";
    chrome.stderr.on("data", (chunk) => {
      log += chunk.toString();
      const match = log.match(/DevTools listening on (ws:\/\/[^\s]+)/u);
      if (match) resolve(match[1]);
    });
    chrome.once("error", reject);
    chrome.once("exit", (code) =>
      reject(new Error(`Chrome exited ${code}: ${log}`)),
    );
  });
  socket = new WebSocket(debuggerUrl);
  await once(socket, "open");
  let sequence = 0;
  const pending = new Map();
  let sessionId;
  socket.on("message", (bytes) => {
    const message = JSON.parse(bytes.toString());
    if (message.id) {
      const waiter = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) waiter?.reject(new Error(message.error.message));
      else waiter?.resolve(message.result);
    }
    if (message.sessionId !== sessionId) return;
    if (message.method === "Network.requestWillBeSent")
      requests.push(message.params.request.url);
    if (message.method === "Runtime.exceptionThrown")
      exceptions.push(message.params.exceptionDetails.text);
    if (message.method === "Fetch.requestPaused") {
      blockedRequests.push(message.params.request.url);
      void command(
        "Fetch.failRequest",
        { requestId: message.params.requestId, errorReason: "BlockedByClient" },
        sessionId,
      );
    }
  });
  const command = (method, params = {}, targetSession) =>
    new Promise((resolve, reject) => {
      const id = ++sequence;
      pending.set(id, { resolve, reject });
      socket.send(
        JSON.stringify({
          id,
          method,
          params,
          ...(targetSession ? { sessionId: targetSession } : {}),
        }),
      );
    });
  browserVersion = (await command("Browser.getVersion")).product;
  const { targetId } = await command("Target.createTarget", {
    url: "about:blank",
  });
  ({ sessionId } = await command("Target.attachToTarget", {
    targetId,
    flatten: true,
  }));
  const page = (method, params = {}) => command(method, params, sessionId);
  await page("Page.enable");
  await page("Runtime.enable");
  await page("Network.enable");
  await page("Fetch.enable", {
    patterns: [{ urlPattern: "http://*" }, { urlPattern: "https://*" }],
  });
  await page("Emulation.setDeviceMetricsOverride", {
    width: 1200,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  const evaluate = async (expression) => {
    const result = await page("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails)
      throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  await page("Page.navigate", { url: pathToFileURL(htmlPath).href });
  await evaluate(`new Promise((resolve, reject) => {
    const test = () => { if (document.getElementById("viewer-status")?.textContent.startsWith("4 / 4")) { observer.disconnect(); clearTimeout(timer); resolve(true); } };
    const observer = new MutationObserver(test);
    const timer = setTimeout(() => { observer.disconnect(); reject(new Error("Fixed CSP-authorized viewer did not initialize")); }, 15000);
    observer.observe(document, { subtree:true, childList:true, characterData:true }); test();
  })`);
  assert.equal(await evaluate("document.scripts.length"), 1);
  assert.equal(
    await evaluate("globalThis.transcriptExecuted === undefined"),
    true,
  );
  assert.equal(
    await evaluate(
      'document.querySelectorAll("[onclick],[onerror],iframe,object,embed,link").length',
    ),
    0,
  );
  assert.equal(
    await evaluate('document.querySelector(".diff-add").textContent'),
    "+new branch\n",
  );
  const rows = () =>
    evaluate(
      'Array.from(document.querySelectorAll("[data-tree-entry]")).filter(node => !node.hidden).map(node => node.dataset.treeEntry)',
    );
  const articles = () =>
    evaluate(
      'Array.from(document.querySelectorAll("article")).filter(node => !node.hidden).map(node => node.id)',
    );
  assert.deepEqual(await rows(), ["root", "old", "new", "schema"]);
  await evaluate(
    "document.querySelector('[data-tree-entry=\"new\"] button').click()",
  );
  assert.deepEqual(await rows(), ["root", "old", "new"]);
  await evaluate(
    "document.querySelector('[data-tree-entry=\"new\"] button').click()",
  );
  assert.deepEqual(await rows(), ["root", "old", "new", "schema"]);
  await evaluate('document.getElementById("viewer-collapse").click()');
  assert.deepEqual(await rows(), ["root"]);
  await evaluate('document.getElementById("viewer-expand").click()');
  assert.deepEqual(await rows(), ["root", "old", "new", "schema"]);
  const select = (id, value) =>
    evaluate(
      `(() => { const node = document.getElementById(${JSON.stringify(id)}); node.value = ${JSON.stringify(value)}; node.dispatchEvent(new Event("change")); })()`,
    );
  await select("viewer-branch", "schema");
  assert.deepEqual(await articles(), [
    "entry-root",
    "entry-new",
    "entry-schema",
  ]);
  assert.deepEqual(await rows(), ["root", "new", "schema"]);
  await select("viewer-branch", "old");
  assert.deepEqual(await articles(), ["entry-root", "entry-old"]);
  await select("viewer-branch", "");
  await select("viewer-origin", "historical");
  assert.deepEqual(await articles(), ["entry-old"]);
  await select("viewer-origin", "current");
  assert.deepEqual(await articles(), [
    "entry-root",
    "entry-new",
    "entry-schema",
  ]);
  await select("viewer-origin", "all");
  await select("viewer-kind", "schema");
  assert.deepEqual(await articles(), ["entry-schema"]);
  await select("viewer-kind", "all");
  await evaluate(
    '(() => { const node = document.getElementById("viewer-search"); node.value = "+new branch"; node.dispatchEvent(new Event("input")); })()',
  );
  assert.deepEqual(await articles(), ["entry-new"]);
  assert.deepEqual(await rows(), ["root", "new"]);
  await evaluate(
    'document.querySelector("#entry-new details:last-child").open = true',
  );
  assert.equal(
    await evaluate(
      'document.getElementById("entry-new").textContent.includes("historical usage, not a new charge")',
    ),
    true,
  );
  await evaluate(
    '(() => { const node = document.createElement("script"); node.textContent = "globalThis.unapprovedInlineExecuted=true"; document.body.appendChild(node); })()',
  );
  assert.equal(
    await evaluate("globalThis.unapprovedInlineExecuted === undefined"),
    true,
  );
  assert.equal(
    await evaluate("globalThis.transcriptExecuted === undefined"),
    true,
  );
  assert.deepEqual(exceptions, []);
  assert.deepEqual(blockedRequests, []);
  assert.deepEqual(
    requests.filter(
      (url) => !url.startsWith("file:") && !url.startsWith("data:"),
    ),
    [],
  );
  const screenshot = join(root, "offline-viewer.png");
  const { data } = await page("Page.captureScreenshot", { format: "png" });
  await writeFile(screenshot, Buffer.from(data, "base64"));
  const evidence = {
    browserVersion,
    root,
    htmlPath,
    screenshot,
    htmlBytes,
    chunks,
    largestChunk,
    hash,
    networkRequests: requests.filter((url) => /^https?:/u.test(url)),
    blockedRequests,
    exceptions,
    assertions: [
      "single exact-hash script",
      "transcript XSS inert",
      "unapproved inline script CSP-blocked",
      "per-node and all-node collapse/expand",
      "active and alternate branch filters",
      "historical/current origin filters",
      "schema filter",
      "search",
      "historical cost distinction",
      ">1MiB streamed file; string API refused",
    ],
  };
  await writeFile(
    join(root, "evidence.json"),
    JSON.stringify(evidence, null, 2),
  );
  console.log(JSON.stringify(evidence, null, 2));
} finally {
  clearTimeout(deadline);
  socket?.close();
  chrome.kill("SIGTERM");
}
